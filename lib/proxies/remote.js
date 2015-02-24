var request = require('request');
var q = require('queue-async');
var CacheOnDemand = require('cache-on-demand');
var bufferEqual = require('buffer-equal');

function dataEqual(a, b) {
	var bufa = Buffer.isBuffer(a);
	var bufb = Buffer.isBuffer(b);
	if (!bufa && !bufb) return a === b;
	if (!bufa) a = new Buffer(a);
	if (!bufb) b = new Buffer(b);
	return bufferEqual(a, b);
}

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
		raja.store.cache.on('eviction', function(url, resource) {
			var poller = self.pollers[url];
			if (!poller) return;
			delete self.pollers[url];
			// let it time out
		});
	});
}

RemoteProxy.prototype.get = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	var raja = this.raja;
	var key = raja.key(url, raja.variant(raja.headers(opts)));
	var poller = this.pollers[key];
	if (!poller) poller = this.pollers[key] = {};
	if (opts.preload) poller.preload = true;
	if (opts.accept) poller.accept = opts.accept;
	cachedLoad.call(this, key, url, poller, opts, cb);
};

var cachedLoad = CacheOnDemand(function(key, url, poller, opts, cb) {
	var raja = this.raja;
	raja.retrieve(key, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) resource = raja.create(url, poller);
		if (!resource.maxage) resource.maxage = opts.maxage || this.opts.maxage;

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
	poller.preloading = true;
	request(obj, function(err, res, body) {
		var code = res && res.statusCode;
		var msg;
		if (err) {
			cb(err);
			if (!poller.preload) return;
		} else {
			poller.foreign = res.headers['x-raja'] !== raja.opts.namespace;
			msg = { key: resource.key, url: resource.url, mtime: new Date() };
		}

		if (code >= 500 || !code) {
			cb(code, resource);
		} else if (code == 404) {
			raja.store.del(resource.url, function(err) {
				if (err) return raja.error(err);
				msg.method = 'delete';
				raja.send(msg);
			});
			// do not track
			return cb(code, resource);
		} else if (code >= 400) {
			// do not track
			return cb(code, resource);
		} else if (code == 304) {
			cb(null, resource);
		}	else if (code >= 200 && code < 300) {
			if (!dataEqual(resource.data, body)) {
				var invalidate = resource.data !== undefined;
				resource.data = body;
				resource.headers = raja.headers(res);
				resource.valid = true; // valid now
				resource.save();
				if (invalidate) {
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
					this.load(resource, poller, raja.error);
				}	else if (resource.valid && !poller.foreign) {
					resource.invalidate(function(err) {
						if (err) return raja.error(err);
						// force parents to update on demand
						raja.send({ url: resource.url, mtime: new Date(), method: 'put' });
					});
				}
			}.bind(this, resource, poller), resource.maxage * 1000);
		}
	}.bind(this));
};

