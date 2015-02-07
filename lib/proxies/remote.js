var request = require('request');
var q = require('queue-async');
var CacheOnDemand = require('cache-on-demand');

module.exports = RemoteProxy;
function RemoteProxy(raja, opts) {
	if (!(this instanceof RemoteProxy)) return new RemoteProxy(raja, opts);
	this.raja = raja;
	this.pollers = {};
	this.opts = opts || {};
	// default value
	if (this.opts.maxage == null) this.opts.maxage = 6000; // 100mn
	var self = this;
	raja.on('ready', function() {
		raja.store.lfu.on('eviction', function(url, resource) {
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
	var poller = this.pollers[url] || {};

	raja.store.get(url, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) resource = {url: url};
		if (!resource.maxage) resource.maxage = opts.maxage || this.opts.maxage;
		if (opts.preload) poller.preload = true;
		this.pollers[url] = poller;
		var delay = resource.mtime && (resource.maxage * 1000 - Date.now() + resource.mtime.getTime());
		var load = true;
		if ((delay > 0 && resource.valid || poller.timeout || poller.preloading) && resource.data != null) {
			cb(null, resource.data);
			load = false;
		}
		if (load) {
			this.load(resource, poller, cb);
		} else if (!poller.timeout && !poller.preloading) {
			poller.timeout = setTimeout(this.load.bind(this, resource, poller, cb), delay);
		}
	}.bind(this));
};

RemoteProxy.prototype.load = CacheOnDemand(function(resource, poller, cb) {
	var raja = this.raja;
	if (!cb) cb = raja.error;
	var obj = { url: resource.url };
	if (resource.etag) obj.headers = { "If-None-Match": resource.etag };
	poller.preloading = true;
	request(obj, function(err, res, body) {
		if (err) return cb(err);
		var code = res.statusCode;
		var foreign = res.headers['X-Raja'] !== raja.opts.namespace;
		var msg = { url: resource.url, mtime: Date.now() };
		if (code >= 500 || !code) {
			cb(code, body);
		} else if (code == 404) {
			raja.store.del(resource.url, function(err) {
				if (err) return raja.error(err);
				msg.method = 'delete';
				raja.send(msg);
			});
			// do not track
			return cb(code);
		} else if (code >= 400) {
			// do not track
			return cb(code);
		} else if (code == 304) {
			cb(null, resource.data);
		}	else if (code >= 200 && code < 300) {
			cb(null, body);
			if (resource.data && typeof resource.data != "string" || typeof body != "string") {
				throw new Error("expected resource.data and body to be strings");
			}
			if (resource.data != body) {
				var invalidate = resource.data !== undefined;
				resource.data = body;
				resource.valid = true; // valid now
				raja.store.set(resource.url, {
					data: body,
					headers: {
						'Content-Type': res.headers['Content-Type'],
						'Etag': res.headers['ETag']
					},
					maxage: resource.maxage
				}, function(err) {
					if (err) return raja.error(err);
					if (!invalidate) return;
					msg.method = 'put';
					raja.send(msg);
				});
			}
		} else {
			console.error("Error while trying to fetch remote resource", code, resource.url);
		}
		poller.preloading = false;
		if (!poller.timeout) {
			poller.timeout = setTimeout(function(resource, poller) {
				delete poller.timeout;
				if (poller.preload) {
					this.load(resource, poller, raja.error);
				}	else if (resource.valid && !foreign) {
					raja.store.invalidate(resource.url, function(err) {
						if (err) return raja.error(err);
						// force parents to update on demand
						raja.send({ url: resource.url, mtime: Date.now(), method: 'put' });
					});
				}
			}.bind(this, resource, poller), resource.maxage * 1000);
		}
	}.bind(this));
}, function(resource) {
	return resource.url;
});

