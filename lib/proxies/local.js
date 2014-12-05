var fs = require('fs');
var q = require('queue-async');

/*
 * the most important point here is: when a file is watched for changes,
 * there is no need to stat it if it is still marked as valid
 * when it isn't watched for changes, mtime comparison is done.
 * When a file is loaded (cache miss) it is cached and watched.
 * Do not try to do LRU stuff in memory - it's up to raja.store to deal with
 * that kind of optimization.
 */

module.exports = LocalProxy;

function LocalProxy(raja) {
	if (!(this instanceof LocalProxy)) return new LocalProxy(raja);
	this.raja = raja;
	this.watches = {};
}

LocalProxy.prototype.get = function(path, cb) {
	this.raja.store.get(path, function(err, resource) {
		if (err) this.raja.error(err); // fall through
		// no early return here - make sure every case is covered
		var load = LocalProxy.prototype.load.bind(this, path, cb);
		if (resource) {
			if (resource.valid) {
				if (this.watches[path]) {
					// the file is watched, validity is ensured
					cb(null, resource.data);
				} else {
					this.watch(path);
					fs.stat(path, function(err, stat) {
						if (err) return cb(err);
						if (stat.mtime.getTime() <= resource.mtime.getTime()) {
							// still valid
							cb(null, resource.data);
						} else {
							load();
						}
					}.bind(this));
				}
			} else {
				load();
			}
		} else {
			load();
		}
	}.bind(this));
};

LocalProxy.prototype.load = function(path, cb) {
	var raja = this.raja;
	fs.readFile(path, function(err, buf) {
		if (err) {
			cb(err);
			raja.store.del(path, function(err) {
				if (err) return raja.error(err);
				raja.send({
					method: "delete",
					path: path
				});
			});
		} else {
			cb(null, buf);
			raja.store.set(path, {
				data: buf
			}, function(err) {
				if (err) return raja.error(err);
				raja.send({
					method: "put",
					path: path
				});
			});
		}
	});
};

LocalProxy.prototype.watch = function(path) {
	if (this.watches[path]) return;
	var raja = this.raja;
	this.watches[path] = fs.watch(path, {persistent: false}, function(ev) {
		var msg = {
			path: path
		};
		if (ev == "change") {
			raja.store.invalidate(path, function(err) {
				if (err) return raja.error(err);
				msg.method = "put";
				raja.send(msg);
			});
		} else if (ev == "rename") {
			raja.store.del(path, function(err) {
				if (err) return raja.error(err);
				msg.method = "delete";
				raja.send(msg);
			});
		}
	});
};

