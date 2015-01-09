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
		if (resource) {
			if (resource.valid) {
				if (this.watches[url]) {
					// the url is watched, validity is ensured
					cb(null, resource.data);
				} else {
					if (this.opts.maxAge * 1000 >= Date.now() - resource.mtime.getTime()) {
						// still valid
						cb(null, resource.data);
					}
					this.watch(resource, cb);
				}
			} else {
				this.watch({url: url}, cb);
			}
		} else {
			this.watch({url: url}, cb);
		}
	}.bind(this));
};

RemoteProxy.prototype.watch = function(resource, cb) {
	var watch = this.watches[resource.url];
	var raja = this.raja;
	if (!watch) watch = new UrlWatch(resource, this.opts.maxAge * 1000 || 300000, raja);
	watch.load(cb);
};

function UrlWatch(resource, maxAge, raja) {
	this.resource = resource;
	this.raja = raja;
	this.maxAge = maxAge;
}

UrlWatch.prototype.load = CacheOnDemand(function(cb) {
	if (this.timeout) clearTimeout(this.timeout);
	this.timeout = setTimeout(this.load.bind(this), this.maxAge);
	var raja = this.raja;
	if (!cb) cb = raja.error;
	var url = this.resource.url;
	var obj = { url: url };
	if (this.etag) obj.headers = { "If-None-Match": this.etag };
	request(obj, function(err, res, body) {
		if (err) return cb(err);
		var code = res.statusCode;
		var msg = { url: url, mtime: Date.now() };
		if (code >= 500) {
			return cb(code, body);
		} else if (code == 404) {
			raja.store.del(url, function(err) {
				if (err) return raja.error(err);
				msg.method = 'delete';
				raja.send(msg);
			});
			return cb(code);
		} else if (code >= 400) {
			return cb(code);
		} else if (code == 304) {
			return cb(null, this.resource.data);
		}	else {
			if (res.headers.etag) this.etag = res.headers.etag;
			cb(null, body);
			if (this.resource.data != body) {
				this.resource.data = body;
				raja.store.set(url, {
					data: body,
					mime: res.headers['Content-Type']
				}, function(err) {
					if (err) return raja.error(err);
					msg.method = 'put';
					raja.send(msg);
				});
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

