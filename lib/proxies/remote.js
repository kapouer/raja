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
	if (this.opts.maxage == null) this.opts.maxage = Infinity;
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

RemoteProxy.prototype.get = function(remote, query, opts, cb) {
	var raja = this.raja;
	if (!cb && !opts && typeof query == "function") {
		cb = query;
		opts = null;
		query = null;
	} else if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (query) {
		remote = raja.agent.substitute(remote, query);
		remote = raja.agent.append(remote, query);
	}
	if (!opts) opts = {};
	var key = raja.key(remote, raja.variant(raja.headers(opts)));
	var poller = this.pollers[key];
	if (!poller) poller = this.pollers[key] = {};
	if (opts.preload) poller.preload = true;
	if (opts.accept) poller.accept = opts.accept;
	if (opts.encoding !== undefined) poller.encoding = opts.encoding;
	if (opts.retry != null) poller.retry = opts.retry;
	cachedLoad.call(this, key, remote, poller, opts, cb);
};

var cachedLoad = CacheDebounce(function(key, url, poller, opts, cb) {
	var raja = this.raja;
	raja.retrieve(key, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) {
			resource = raja.create(url, poller);
		}
		if (!resource.maxage) resource.maxage = opts.maxage || this.opts.maxage;
		if (!resource.url) resource.url = url;

		var delay = resource.mtime && (resource.maxage * 1000 - Date.now() + resource.mtime.getTime());
		if ((delay > 0 && resource.valid || poller.timeout || poller.preloading) && resource.data != null) {
			cb(null, resource);
			cb = null;
		}
		if (cb) {
			this.load(resource, poller, cb);
		} else if (!poller.timeout && !poller.preloading && delay > 0 && delay < Infinity) {
			poller.timeout = setTimeout(this.load.bind(this, resource, poller, raja.error), delay);
		}
	}.bind(this));
}, function(key) {
	return key;
});

RemoteProxy.prototype.load = function(resource, poller, cb) {
	var raja = this.raja;
	var obj = { url: resource.url, headers: {} };
	if (resource.headers && resource.headers.ETag) {
		obj.headers["If-None-Match"] = resource.headers.ETag;
	}
	if (poller.accept) {
		obj.headers["Accept"] = poller.accept == 'json' ? 'application/json' : poller.accept;
	}
	if (poller.encoding !== undefined) {
		obj.encoding = poller.encoding;
	}
	poller.preloading = true;
	debug('request', obj);
	request(obj, function(err, res, body) {
		var code = res && res.statusCode;
		debug('response', code, 'with body length', body && body.length);
		var msg;
		if (err) {
			if (!poller.preload) return cb(err);
		} else {
			poller.foreign = res.headers['x-raja'] !== raja.opts.namespace;
			msg = { key: resource.key, url: resource.url, mtime: new Date() };
		}
		var canRetry = poller.retry && poller.retry.indexOf(code) >= 0;

		if (code >= 500 || !code) {
			cb(code, resource);
		} else if (code == 404) {
			if (!canRetry) {
				raja.store.del(resource.url, function(err) {
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
		poller.preloading = false;
		if (!poller.timeout && resource.maxage < Infinity) {
			poller.timeout = setTimeout(function(resource, poller) {
				delete poller.timeout;
				if (poller.preload) {
					debug('preload', resource.key);
					this.load(resource, poller, raja.error);
				}	else if (resource.valid && poller.foreign) {
					// this resource is not tracked by raja proxies
					// invalidate it and its parents
					debug('invalidate foreign', resource.key);
					resource.invalidate(function(err) {
						if (err) return raja.error(err);
						raja.send({ url: resource.url, mtime: new Date(), method: 'put' });
					});
				}
			}.bind(this, resource, poller), resource.maxage * 1000);
		}
	}.bind(this));
};

