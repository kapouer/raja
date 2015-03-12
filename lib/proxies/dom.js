var URL = require('url');
var queue = require('queue-async');
var CacheOnDemand = require('cache-on-demand');
var type = require('type-is');

module.exports = DomProxy;

function DomProxy(raja, opts) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, opts);
	this.raja = raja;
	var Dom = this.Dom = opts.dom;

	var ioreg;

	var self = this;

	Dom.use(function(h) {
		h.page.run(function(client, ns, done) {
			var node = document.getElementById('script');
			if (!node) node = document.createElement('script');
			node.id = 'raja';
			node.setAttribute('client', client);
			node.setAttribute('namespace', ns);
			node.setAttribute('room', document.location.href);
			node.type = "text/javascript";
			node.textContent = "(function(r) {if (r && r.ready) r.ready();})(window.raja);";
			if (!node.parentNode) {
				var tn = document.createTextNode("\n");
				document.head.insertBefore(node, document.head.firstChild);
				document.head.insertBefore(tn, node);
			}
			done();
		}, [opts.client, opts.namespace]);
	}, 'before');

	var listener = function(msg) {
		var url = raja.keyObj(msg.key || msg.url).url;
		var parent = raja.keyObj(msg.parents.slice(-1).pop()).url;
		var h = this;
		if (url == h.view.url && msg.mtime > h.view.mtime) {
			// this is probably going to be rewritten as with msg.parents below
			h.view.mtime = msg.mtime;
			raja.store.invalidate(h.view.url, raja.error);
			return;
		}
		var inst = parent && Dom.pages[parent];
		if (!inst) return;

		msg.parents.forEach(function(key) {
			var url = raja.keyObj(key).url;
			// url is a key but all comparisons should be fine in these cases
			if (url == inst.author.url && msg.mtime > inst.author.mtime && (!inst.author.itime || msg.mtime > inst.author.itime)) {
				inst.author.itime = msg.mtime;
				raja.store.invalidate(inst.author.url, raja.error);
			} else if (url == inst.user.url && msg.mtime > inst.user.mtime && (!inst.user.itime || msg.mtime > inst.user.itime)) {
				inst.user.itime = msg.mtime;
				raja.store.invalidate(inst.user.key, raja.error);
			} else {
				var hasChild = inst.user.resources[key];
				if (!hasChild) return;
				raja.retrieve(key, function(err, child) {
					if (err) return raja.error(err);
					if (!child) return;
					if (child && child.headers && type.is(child.headers['Content-Type'], '*/javascript')) {
						// force reload of file on next page reload
						console.info("Detected change in", url);
						if (!inst.reloads) inst.reloads = {};
						inst.reloads[url] = msg.mtime;
					}
				});
			}
		});
	};

	Dom.Handler.prototype.init = function() {
		this.listener = listener.bind(this);
		raja.on('message', this.listener);
	};

	Dom.Handler.prototype.loadLocal = raja.proxies.local.get.bind(raja.proxies.local);

	Dom.Handler.prototype.loadRemote = function(url, opts, cb) {
		raja.proxies.remote.get(url, opts, function(err, res) {
			cb(err, res && res.data);
		});
	};

	var build = Dom.Handler.prototype.build;
	Dom.Handler.prototype.build = CacheOnDemand(function(inst, req, res, cb) {
		res.set('X-Raja', opts.namespace);
		build.call(this, inst, req, res, cb);
	}, function(inst) {
		return inst.user.url;
	});

	Dom.author(domProxyPlugin, 'before');
	Dom.use(domProxyPlugin, 'before');
	Dom.use(domProxyBusyPlugin, 'before');

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
			if (type.is(req.mime, "octet-stream") || type.is(req.mime, 'javascript') == false && ioreg && ioreg.test(URL.parse(req.uri).pathname)) {
				req.ignore = true;
			}
		});
		inst.page.on('response', function(res) {
			if (res.uri == inst.user.url) return; // ignore view and author
			if (!inst.user.resources) return;
			if (res.status >= 200 && res.status < 400) {
				if (!ioreg) {
					var iopath = raja.io && raja.io.socket && raja.io.socket.io.opts.path;
					if (iopath) ioreg = new RegExp("^" + iopath);
				}
				if (type.is(res.mime, "octet-stream") || type.is(res.mime, 'javascript') == false && ioreg && ioreg.test(URL.parse(res.uri).pathname)) {
					inst.weight = 4; // prioritize "live" pages
					inst.live = true;
				} else {
					var mime = res.mime;
					var headers = raja.headers(res.headers);
					headers['Content-Type'] = res.mime;
					var key = raja.key(res.uri, raja.vary(headers));
					if (!inst.user.resources[key]) {
						raja.create({
							key: key,
							url: res.uri,
							headers: headers
						}).save();
						inst.user.resources[key] = true;
					}

					// this covers the case where a resource finishes loading after idle
					if (inst.user.valid) {
						inst.user.itime = new Date();
						inst.user.invalidate(raja.error);
						inst.user.save();
					}
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
				// call invalidate ?
				inst.user.save();
			}
		});
	}

	var _getView = Dom.Handler.prototype.getView;
	Dom.Handler.prototype.getView = function(req, cb) {
		var h = this;
		raja.retrieve(h.view.url, function(err, resource) {
			if (err) return cb(err);
			if (!resource) resource = raja.create(h.view).save();
			h.view = resource;
			if (resource.valid) return cb();
			_getView.call(h, req, function(err) {
				if (err) return cb(err);
				h.view.save();
				cb();
			});
		});
	};

	var _getAuthored = Dom.Handler.prototype.getAuthored;
	Dom.Handler.prototype.getAuthored = function(inst, req, res, cb) {
		var h = this;
		raja.retrieve(inst.author.url, function(err, resource) {
			if (err) return cb(err);
			if (!resource) resource = raja.create(inst.author).save();
			inst.author = resource;
			if (!resource.headers) resource.headers = {};
			if (!resource.resources) resource.resources = {};
			if (resource.valid) return cb();
			_getAuthored.call(h, inst, req, res, function(err) {
				if (err) return cb(err);
				resource.headers['Content-Type'] = 'text/html';
				resource.depend(h.view);
				resource.save();
				cb();
			});
		});
	};

	var _getUsed = Dom.Handler.prototype.getUsed;
	Dom.Handler.prototype.getUsed = function(inst, req, res, cb) {
		var h = this;
		raja.retrieve(inst.user.url, req, function(err, resource) {
			if (err) return cb(err);
			if (!resource) resource = raja.create(inst.user, res);
			inst.user = resource;
			if (!resource.headers) resource.headers = {};
			resource.headers['Content-Type'] = 'text/html';
			if (!resource.resources) resource.resources = {};
			resource.save();
			if (inst.page && inst.live && !inst.reloads) {
				inst.page.locked = true;
				inst.output(inst.page, function(err, str) {
					inst.page.locked = false;
					if (str) {
						resource.data = str;
					}
					next(err);
				});
			} else {
				inst.existings = resource.resources;
				resource.resources = {};
				resource.depend(inst.author);
				resource.valid = false;
				_getUsed.call(h, inst, req, res, next);
			}
			function next(err) {
				if (err) return cb(err);
				if (inst.existings) delete inst.existings;
				if (inst.reloads) delete inst.reloads;
				if (!resource.itime || resource.itime <= resource.mtime) {
					resource.valid = true;
					resource.mtime = new Date();
					resource.save();
				} else if (!resource.mtime) {
					resource.mtime = new Date();
				}
				cb();
			}
		});
	};
}

