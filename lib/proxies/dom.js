var URL = require('url');
var queue = require('queue-async');
var CacheOnDemand = require('cache-on-demand');

module.exports = DomProxy;

function DomProxy(raja, opts) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, opts);
	this.raja = raja;
	var Dom = opts.dom;

	var ioreg;

	var self = this;

	Dom.author(function(h) {
		h.page.run(function(ioclientUri, done) {
			if (ioclientUri) {
				var meta = document.createElement('meta');
				meta.id = 'raja-io';
				meta.content = ioclientUri;
				var tn = document.createTextNode("\n");
				document.head.insertBefore(meta, document.head.firstChild);
				document.head.insertBefore(tn, meta);
			}
			done();
		}, opts.client);
	});
	var listener = function(msg) {
		var url = msg.url;
		var parent = msg.parents.slice(-1).pop();
		var h = this;
		if (url == h.view.url && msg.mtime > h.view.mtime) {
			// this is probably going to be rewritten as with msg.parents below
			h.view.mtime = msg.mtime;
			raja.store.invalidate(h.view.url, raja.error);
			return;
		}
		var inst = parent && h.pages[parent];
		if (!inst) return;

		msg.parents.forEach(function(url) {
			if (url == inst.author.url && msg.mtime > inst.author.mtime && (!inst.author.itime || msg.mtime > inst.author.itime)) {
				inst.author.itime = msg.mtime;
				raja.store.invalidate(inst.author.url, raja.error);
			} else if (url == inst.user.url && msg.mtime > inst.user.mtime && (!inst.user.itime || msg.mtime > inst.user.itime)) {
				inst.user.itime = msg.mtime;
				raja.store.invalidate(inst.user.url, raja.error);
			} else if (/^.*\/javascript$/.test(inst.user.resources[url])) {
				// force reload of page on next get
				inst.live = false;
				// force reload of file on next page reload
				if (!inst.reloads) inst.reloads = {};
				inst.reloads[url] = msg.mtime;
			}
		});
	};
	Dom.Handler.prototype.init = function() {
		this.listener = listener.bind(this);
		raja.on('message', this.listener);
	};

	Dom.Handler.prototype.loadLocal = raja.proxies.local.get.bind(raja.proxies.local);
	Dom.Handler.prototype.loadRemote = raja.proxies.remote.get.bind(raja.proxies.remote);

	var build = Dom.Handler.prototype.build;
	Dom.Handler.prototype.build = CacheOnDemand(function(inst, req, res, cb) {
		res.set('X-Raja', opts.namespace);
		build.call(this, inst, req, res, cb);
	}, function(inst) {
		return inst.user.url;
	});

	Dom.authors.unshift(domProxyPlugin); // problème: cela va charger une page pour rien
	Dom.users.unshift(domProxyPlugin);
	Dom.users.unshift(domProxyBusyPlugin);

	function domProxyPlugin(inst) {
		inst.page.on('unload', function() {}); // keep it running !
		inst.page.on('error', raja.error.bind(raja));
		inst.page.on('request', function(req) {
			if (!inst.user.resources) return;
			if (inst.existings && inst.existings[req.uri]) {
				// copy back because some of them won't have response because of the cache
				inst.user.resources[req.uri] = inst.existings[req.uri];
			}
			if (inst.reloads && inst.reloads[req.uri]) {
				req.headers['Cache-Control'] = 'no-cache';
			}
			if (req.mime == "application/octet-stream" || /^.*\/javascript$/.test(req.mime) == false && ioreg && ioreg.test(URL.parse(req.uri).pathname)) {
				req.ignore = true;
			}
		});
		inst.page.on('response', function(res) {
			if (res.uri == inst.user.url) return; // ignore view and author
			if (res.status >= 200 && res.status < 400) {
				if (!ioreg) {
					var iopath = raja.io && raja.io.socket && raja.io.socket.io.opts.path;
					if (iopath) ioreg = new RegExp("^" + iopath);
				}
				if (res.mime == "application/octet-stream" || /^.*\/javascript$/.test(res.mime) == false && ioreg && ioreg.test(URL.parse(res.uri).pathname)) {
					inst.weight = 4; // prioritize "live" pages
					inst.live = true;
				} else {
					var mime = res.mime;
					var oldMime = inst.user.resources[res.uri];
					if (!oldMime) {
						if (!mime) mime = true;
					} else if (!mime) mime = oldMime;
					inst.user.resources[res.uri] = mime;
					// this covers the case where a resource finishes loading after idle
					inst.user.itime = new Date();
					raja.store.set(inst.user.url, {resources: inst.user.resources}, raja.error);
					raja.store.invalidate(inst.user.url, raja.error);
				}
			}
		});
	}

	function domProxyBusyPlugin(inst) {
		inst.page.on('busy', function() {
			if (inst.user.itime && inst.user.itime > inst.user.mtime) {
				delete inst.user.itime;
				// update resources to make sure instances loaded on server receive messages
				inst.user.valid = false;
				raja.store.set(inst.user.url, inst.user, raja.error);
			}
		});
	}

	var _getView = Dom.Handler.prototype.getView;
	Dom.Handler.prototype.getView = function(req, cb) {
		var h = this;
		raja.store.get(h.view.url, function(err, resource) {
			if (err) return cb(err);
			if (resource) {
				h.view = resource;
				if (resource.valid) return cb();
			}
			_getView.call(h, req, function(err) {
				if (err) return cb(err);
				// disable until proven it's useful - proxies already saved that resource
				// raja.store.set(h.view.url, h.view, cb);
				cb();
			});
		});
	};

	var _getAuthored = Dom.Handler.prototype.getAuthored;
	Dom.Handler.prototype.getAuthored = function(inst, req, res, cb) {
		var h = this;
		var resources = inst.author.resources;
		delete inst.author.resources;
		raja.store.set(inst.author.url, inst.author, function(err, resource) {
			if (err) return cb(err);
			inst.author = resource;
			if (resources) resource.resources = resources;
			if (!inst.author.headers) inst.author.headers = {};
			if (!inst.author.resources) inst.author.resources = {};
			if (inst.author.valid) return cb();
			_getAuthored.call(h, inst, req, res, function(err) {
				if (err) return cb(err);
				inst.author.headers['Content-Type'] = 'text/html';
				inst.author.resources[h.view.url] = true;
				raja.store.set(inst.author.url, inst.author, cb);
			});
		});
	};

	var _getUsed = Dom.Handler.prototype.getUsed;
	Dom.Handler.prototype.getUsed = function(inst, req, res, cb) {
		var h = this;
		var resources = inst.user.resources;
		delete inst.user.resources;
		raja.store.set(inst.user.url, inst.user, function(err, resource) {
			if (err) return cb(err);
			inst.user = resource;
			if (resources) resource.resources = resources;
			if (!inst.user.headers) inst.user.headers = {};
			if (!inst.user.resources) inst.user.resources = {};
			if (inst.user.valid) {
				return cb();
			}
			if (inst.page && inst.live) {
				inst.page.html(function(err, html) {
					if (html) {
						inst.user.data = html;
					}
					next(err);
				});
			} else {
				if (inst.user.resources) inst.existings = inst.user.resources;
				inst.user.resources = {};
				inst.user.resources[inst.author.url] = true;
				_getUsed.call(h, inst, req, res, next);
			}
		});

		function next(err) {
			if (err) return cb(err);
			if (inst.existings) delete inst.existings;
			if (inst.reloads) delete inst.reloads;
			if (!inst.user.itime || inst.user.itime <= inst.user.mtime) {
				inst.user.valid = true;
				inst.user.mtime = new Date();
				inst.user.headers['Content-Type'] = 'text/html';
				raja.store.set(inst.user.url, inst.user, cb);
			} else {
				cb();
			}
		}
	};
}

