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
RemoteProxy.prototype.get = function(url, cb) {
	this.raja.store.get(url, function(err, resource) {
		if (err) raja.error(err); // fall through
		if (resource && resource.valid) {
			if (this.watches[url]) {
				// the url is watched, validity is ensured
				cb(null, resource.data);
			} else {
				this.watch(resource, cb);
			}
		} else {
			this.watch({url: url}, cb);
		}
	}.bind(this));
};

RemoteProxy.prototype.watch = function(resource, cb) {
	var watch = this.watches[resource.url];
	var raja = this.raja;
	var maxage = this.opts.maxage || 600;
	if (resource.maxage != maxage) resource.maxage = maxage;
	if (!watch) {
		watch = this.watches[resource.url] = new UrlWatch(resource, raja);
		var delay = resource.mtime && (resource.maxage * 1000 - Date.now() + resource.mtime.getTime());
		if (delay > 0) {
			// still valid
			setTimeout(watch.load.bind(watch, cb), delay + 100);
			return cb(null, resource.data);
		}
	}
	watch.load(cb);
};

function UrlWatch(resource, raja) {
	this.resource = resource;
	this.raja = raja;
}

UrlWatch.prototype.load = CacheOnDemand(function(cb) {
	if (this.timeout) clearTimeout(this.timeout);
	var raja = this.raja;
	if (!cb) cb = raja.error;
	var resource = this.resource;
	var obj = { url: resource.url };
	if (this.etag) obj.headers = { "If-None-Match": this.etag };
	request(obj, function(err, res, body) {
		if (err) return cb(err);
		var code = res.statusCode;
		var maxage = res.headers['X-Raja'] === raja.opts.namespace ? null : resource.maxage;
		var msg = { url: resource.url, mtime: Date.now() };
		if (code >= 500) {
			return cb(code, body);
		} else if (code == 404) {
			raja.store.del(resource.url, function(err) {
				if (err) return raja.error(err);
				msg.method = 'delete';
				raja.send(msg);
			});
			return cb(code);
		} else if (code >= 400) {
			return cb(code);
		} else if (code == 304) {
			cb(null, this.resource.data);
		}	else {
			if (res.headers.etag) this.etag = res.headers.etag;
			cb(null, body);
			if (this.resource.data != body) {
				this.resource.data = body;
				raja.store.set(resource.url, {
					data: body,
					mime: res.headers['Content-Type'],
					maxage: maxage
				}, function(err) {
					if (err) return raja.error(err);
					msg.method = 'put';
					raja.send(msg);
				});
			}
		}
		if (maxage) {
			this.timeout = setTimeout(this.load.bind(this, raja.error), maxage * 1000);
		}
	}.bind(this));
}, "cache");

UrlWatch.prototype.unload = function() {
	if (this.timeout) {
		clearTimeout(this.timeout);
		delete this.timeout;
	}
};

