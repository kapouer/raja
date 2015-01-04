var request = require('request');
var q = require('queue-async');
var CacheOnDemand = require('cache-on-demand');

module.exports = RemoteProxy;
function RemoteProxy(raja, opts) {
	if (!(this instanceof RemoteProxy)) return new RemoteProxy(raja, opts);
	this.raja = raja;
	this.watches = {};
	this.opts = opts || {};
}
RemoteProxy.prototype.get = function(path, cb) {
	this.raja.store.get(path, function(err, resource) {
		if (err) raja.error(err); // fall through
		if (resource) {
			if (resource.valid) {
				if (this.watches[path]) {
					// the url is watched, validity is ensured
					cb(null, resource.data);
				} else {
					if (this.opts.maxAge * 1000 >= Date.now() - resource.mtime.getTime()) {
						// still valid
						cb(null, resource.data);
					} else {
						this.watch(path, cb);
					}
				}
			} else {
				this.watch(path, cb);
			}
		} else {
			this.watch(path, cb);
		}
	}.bind(this));
};

RemoteProxy.prototype.watch = function(path, cb) {
	var watch = this.watches[path];
	var raja = this.raja;
	if (!watch) watch = new UrlWatch(path, this.opts.maxAge || 300000, raja);
	watch.load(cb);
};

function UrlWatch(url, maxAge, raja) {
	this.url = url;
	this.raja = raja;
}

UrlWatch.prototype.load = CacheOnDemand(function(cb) {
	if (this.timeout) clearTimeout(this.timeout);
	this.timeout = setTimeout(this.load.bind(this));
	var raja = this.raja;
	if (!cb) cb = raja.error;
	var obj = {
		url: this.url
	};
	if (this.etag) obj.headers = { "If-None-Match": this.etag };
	request(obj, function(err, res, body) {
		if (err) return cb(err);
		if (res.statusCode >= 500) {
			return cb(res.statusCode, body);
		} else if (res.statusCode == 404) {
			raja.store.del(this.url, function(err) {
				if (err) return raja.error(err);
				this.change({
					method: "delete",
					url: this.url
				});
			}.bind(this));
			return cb(res.statusCode);
		} else if (res.statusCode >= 400) {
			return cb(res.statusCode);
		} else if (res.statusCode == 304) {
			return cb(null, this.data);
		}	else {
			if (res.headers.etag) this.etag = res.headers.etag;
			cb(null, body);
			if (this.data != body) {
				this.data = body;
				raja.store.set(this.url, {data: body}, function(err) {
					if (err) return raja.error(err);
					this.change({
						method: "put",
						url: this.url
					});
				}.bind(this));
			}
		}
	}.bind(this));
}, "cache");

UrlWatch.prototype.unload = function() {
	if (this.timeout) {
		clearTimeout(this.timeout);
		delete this.timeout;
	}
};

