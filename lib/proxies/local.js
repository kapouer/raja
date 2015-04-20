var fs = require('fs');
var Path = require('path');
var CacheDebounce = require('cache-debounce');
var chokidar = require('chokidar');
var debounce = require('debounce');
var q = require('queue-async');
var debug = require('debug')('raja:local');

/*
 * the most important point here is: when a file is watched for changes,
 * there is no need to stat it if it is still marked as valid
 * when it isn't watched for changes, mtime comparison is done.
 * When a file is loaded (cache miss) it is cached and watched.
 */

module.exports = LocalProxy;

function LocalProxy(raja, opts) {
	if (!(this instanceof LocalProxy)) return new LocalProxy(raja, opts);
	this.raja = raja;
	this.watches = {};
	process.on('exit', function() {
		for (var key in this.watches) {
			this.watches[key].watcher.close();
		}
	}.bind(this));
}

LocalProxy.prototype.get = CacheDebounce(function(path, cb) {
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
					this.watch(path);
					fs.stat(path, function(err, stat) {
						if (err) return cb(err);
						if (stat.mtime.getTime() <= resource.mtime.getTime()) {
							// still valid
							cb(null, resource.data);
						} else {
							this.load(path, function(err, buf) {
								// not up to us to validate resource ?
								cb(err, buf);
								// invalidate parents
								this.raja.send({
									method: buf ? 'put' : 'delete',
									key: resource.key,
									url: resource.url,
									mtime: stat.mtime
								});
							}.bind(this));
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
}, function(path) {
	return path;
});

LocalProxy.prototype.load = function(path, cb) {
	var raja = this.raja;
	fs.readFile(path, function(err, buf) {
		if (err) {
			raja.store.del(path, raja.error);
			cb(err);
		} else {
			raja.upsert({url: path, data: buf }, raja.error);
			cb(null, buf);
		}
	});
};

LocalProxy.prototype.watched = function(path) {
	var dir = Path.dirname(path);
	var watcher = this.watches[dir];
	if (!watcher) return false;
	return !!watcher.paths[path];
};

function changeListener(change, dir, path) {
	debug('change event', path);
	var w = this.watches[dir];
	if (!w) return console.info("no watcher exists for that directory", dir);
	if (!w.paths[path]) return;
	var raja = this.raja;
	change(this.raja, path);
}

function change(raja, path) {
	raja.store.invalidate(path, function(err) {
		if (err) raja.error(err);
		raja.send({
			method: "put",
			url: path
		});
	});
}

function unlinkListener(unlink, dir, path) {
	debug('unlink event', path);
	var w = this.watches[dir];
	if (!w) return console.info("no watcher exists for that directory", dir);
	if (!w.paths[path]) return;
	unlink(this.raja, path);
}

function unlink(raja, path) {
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
		debug('watch', dir);
		w = this.watches[dir] = {
			watcher: chokidar.watch(dir, {depth: 0, persistent: true, atomic: false, followSymlinks: true})
				.on('change', debounce(changeListener.bind(this, change, dir), 500))
				.on('unlink', debounce(unlinkListener.bind(this, unlink, dir), 500)),
			paths: {}
		};
	}
	w.paths[path] = true;
};

