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

	this.raja.store.lfu.on('eviction', function(url, resource) {
		var poller = this.pollers[url];
		if (!poller) return;
		poller.active = false;
		delete this.pollers[url];
		if (poller.timeout) {
			clearTimeout(poller.timeout);
			delete poller.timeout;
		}
	}.bind(this));
}

RemoteProxy.prototype.get = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	var raja = this.raja;
	var poller = this.pollers[url] || {active: false};

	raja.store.get(url, function(err, resource) {
		if (err) raja.error(err);
		if (!resource) resource = {url: url};
		if (resource.maxage == null) resource.maxage = this.opts.maxage;
		if (opts.maxage !== null) resource.maxage = opts.maxage;
		if (opts.poll) {
			poller.active = true;
			this.pollers[url] = poller;
		}
		if (poller.active) {
			if (poller.timeout) {
				// really active, if there is data it's good data
				if (resource.data !== null) return cb(null, resource.data);
			} else {
				var delay = resource.mtime && (resource.maxage * 1000 - Date.now() + resource.mtime.getTime());
				if (delay > 0) {
					poller.timeout = setTimeout(this.load.bind(this, resource, poller, cb), delay);
					// data is still valid and we'll get a notification anyway
					if (resource.data !== null) return cb(null, resource.data);
				}
			}
		}
		if (resource.valid && resource.data !== null) return cb(null, resource.data);
		this.load(resource, poller, cb);
	}.bind(this));
};

RemoteProxy.prototype.load = CacheOnDemand(function(resource, poller, cb) {
	var raja = this.raja;
	if (!cb) cb = raja.error;
	var obj = { url: resource.url };
	if (resource.etag) obj.headers = { "If-None-Match": resource.etag };
	request(obj, function(err, res, body) {
		if (err) return cb(err);
		var code = res.statusCode;
		var poll = res.headers['X-Raja'] !== raja.opts.namespace && poller;
		var msg = { url: resource.url, mtime: Date.now() };
		if (code >= 500) {
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
		}	else {
			if (res.headers.etag) resource.etag = res.headers.etag;
			cb(null, body);
			if (resource.data != body) {
				resource.data = body;
				raja.store.set(resource.url, {
					data: body,
					mime: res.headers['Content-Type'],
					maxage: resource.maxage,
					poll: poller.active
				}, function(err) {
					if (err) return raja.error(err);
					msg.method = 'put';
					raja.send(msg);
				});
			}
		}
		if (resource.maxage && !poller.timeout) {
			poller.timeout = setTimeout(function(resource, poller) {
				if (poller.active) {
					this.load(resource, poller, raja.error);
				}	else {
					raja.store.invalidate(resource.url, function(err) {
						delete poller.timeout;
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

