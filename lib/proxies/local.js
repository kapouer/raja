var fs = require('fs');
var Path = require('path');
var chokidar = require('chokidar');
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
	process.on('exit', function() {
		for (var key in this.watches) {
			this.watches[key].watcher.close();
		}
	}.bind(this));
}

LocalProxy.prototype.get = function(path, cb) {
	this.raja.store.get(path, function(err, resource) {
		if (err) this.raja.error(err); // fall through
		// no early return here - make sure every case is covered
		var load = LocalProxy.prototype.load.bind(this, path, cb);
		if (resource) {
			if (resource.valid) {
				if (this.watched(path)) {
					// the file is watched, validity is ensured
					cb(null, resource.data);
				} else {
					// this should actually never happen because store is emptied when app starts
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
			this.watch(path);
			load();
		}
	}.bind(this));
};

LocalProxy.prototype.load = function(path, cb) {
	var raja = this.raja;
	fs.readFile(path, function(err, buf) {
		if (err) {
			cb(err);
			raja.store.del(path, raja.error);
		} else {
			cb(null, buf);
			raja.store.set(path, { data: buf }, raja.error);
		}
	});
};

LocalProxy.prototype.watched = function(path) {
	var dir = Path.dirname(path);
	var watcher = this.watches[dir];
	if (!watcher) return false;
	return !!watcher.paths[path];
};

function change(dir, path) {
	var w = this.watches[dir];
	if (!w) return console.info("no watcher exists for that directory", dir);
	if (!w.paths[path]) return;
	var raja = this.raja;
	raja.store.invalidate(path, function(err) {
		if (err) return raja.error(err);
		raja.send({
			method: "put",
			url: path
		});
	});
}

function unlink(dir, path) {
	var w = this.watches[dir];
	if (!w) return console.info("no watcher exists for that directory", dir);
	if (!w.paths[path]) return;
	var raja = this.raja;
	raja.store.del(path, function(err) {
		if (err) return raja.error(err);
		raja.send({
			method: "delete",
			url: path
		});
	});
}

LocalProxy.prototype.watch = function(path) {
	var dir = Path.dirname(path);
	var w = this.watches[dir];
	if (!w) {
		w = this.watches[dir] = {
			watcher: chokidar.watch(dir, {depth: 1})
				.on('change', change.bind(this, dir))
				.on('unlink', unlink.bind(this, dir)),
			paths: {}
		};
	}
	w.paths[path] = true;
};

