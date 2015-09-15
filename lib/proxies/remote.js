var request = require('request');
var q = require('queue-async');
var CacheDebounce = require('cache-debounce');
var debug = require('debug')('raja:remote');

module.exports = RemoteProxy;
function RemoteProxy(raja, opts) {
	if (!(this instanceof RemoteProxy)) return new RemoteProxy(raja, opts);
	this.raja = raja;
	this.pollers = {};
	this.opts = opts || {};
	// default value
	if (this.opts.maxage == null) this.opts.maxage = 0;
	var self = this;
	raja.on('ready', function() {
		raja.store.cache.on('eviction', function(key, resource) {
			var poller = self.pollers[key];
			if (!poller) return;
			delete self.pollers[key];
			// let it time out
		});
	});
}

RemoteProxy.prototype.get = function(url, opts, cb) {
	var raja = this.raja;
	if (!cb && typeof opts == "function") {
		cb = opts
		opts = null;
	}
	var req = raja.shallow(opts);
	req.url = url;
	if (!req.headers) req.headers = {};
	if (req.params) {
		req.url = raja.agent.substitute(req.url, req.params);
	}
	if (req.query) {
		req.url = raja.agent.append(req.url, req.query);
	}
	if (req.accept) {
		req.headers.Accept = req.accept == "json" ? "application/json" : req.accept;
	}
	if (req.maxage == null) req.maxage = this.opts.maxage;

	var key = raja.reqkey({url: req.url, headers: raja.headers(req.headers)});
	this.pollers[key] = req;

	cachedLoad.call(this, key, req, cb);
};

var cachedLoad = CacheDebounce(function(key, req, cb) {
	var raja = this.raja;
	raja.retrieve(key, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) {
			resource = raja.create({url: req.url, builder: 'remote'}, req);
		}
		if (resource.maxage == null) resource.maxage = req.maxage;
		var delay = resource.maxage > 0 && resource.mtime && (resource.maxage * 1000 - Date.now() + Date.parse(resource.mtime));
		if ((delay > 0 && resource.valid || req.timeout || req.preloading) && resource.data != null) {
			cb(null, resource);
			cb = null;
		}
		if (cb) {
			this.load(resource, req, cb);
		} else if (!req.timeout && !req.preloading && delay > 0 && delay < Infinity) {
			req.timeout = setTimeout(this.load.bind(this, resource, req, raja.error), delay);
		}
	}.bind(this));
}, function(key) {
	return key;
});

RemoteProxy.prototype.load = function(resource, req, cb) {
	var raja = this.raja;
	var obj = { url: resource.url, headers: req.headers };
	if (resource.headers && resource.headers.ETag) {
		obj.headers["If-None-Match"] = resource.headers.ETag;
	}
	if (req.encoding !== undefined) {
		obj.encoding = req.encoding;
	}
	req.preloading = true;
	debug('request', obj);
	request(obj, function(err, res, body) {
		var code = res && res.statusCode;
		debug('response', code, obj.url, body && body.length);
		var msg;
		if (err) {
			if (!req.preload) return cb(err);
		} else {
			// res is IncomingMessage - has no get method, uses lowercased field names
			req.foreign = res.headers['x-raja'] !== raja.opts.namespace;
			msg = { key: resource.key, mtime: new Date() };
		}
		var canRetry = req.retry && req.retry.indexOf(code) >= 0;

		if (code >= 500 || !code) {
			cb(code, resource);
		} else if (code == 404) {
			if (!canRetry) {
				raja.store.del(resource.key, function(err) {
					if (err) return raja.error(err);
					msg.method = 'delete';
					raja.send(msg);
				});
				return cb(code, resource);
			} else {
				resource.data = null;
				cb(null, resource);
			}
		} else if (code >= 400) {
			// do not track
			if (!canRetry) return cb(code, resource);
			resource.data = null;
			cb(null, resource);
		} else if (code == 304) {
			cb(null, resource);
		}	else if (code >= 200 && code < 300) {
			if (!raja.dataEqual(resource.data, body)) {
				var invalidate = resource.data !== undefined;
				resource.data = body !== undefined ? body : null;
				resource.headers = raja.headers(res);
				resource.valid = true; // valid now
				resource.save();
				if (invalidate) {
					debug('invalidate', resource.key);
					msg.method = 'put';
					raja.send(msg);
				}
			}
			cb(null, resource);
		} else {
			console.error("Error while trying to fetch remote resource", code, resource.url);
		}
		req.preloading = false;
		if (!req.timeout && resource.maxage > 0) {
			req.timeout = setTimeout(function(resource, req) {
				delete req.timeout;
				if (req.preload) {
					debug('preload', resource.key);
					this.load(resource, req, raja.error);
				}	else if (resource.valid && req.foreign) {
					// this resource is not tracked by raja proxies
					// invalidate it and its parents
					debug('invalidate foreign', resource.key);
					resource.invalidate(function(err) {
						if (err) return raja.error(err);
						raja.send({ key: resource.key, mtime: new Date(), method: 'put' });
					});
				}
			}.bind(this, resource, req), resource.maxage * 1000);
		}
	}.bind(this));
};

