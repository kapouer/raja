var URL = require('url');
var queue = require('queue-async');
var CacheDebounce = require('cache-debounce');
var type = require('type-is');
var cookie = require('cookie');
var signature = require('cookie-signature');

module.exports = DomProxy;

function DomProxy(raja, opts) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, opts);
	this.raja = raja;
	var Dom = this.Dom = opts.dom;

	var ioreg;

	var self = this;

	Dom.use(function(h, req, res) {
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

	if (opts.disable) return;
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
	Dom.Handler.prototype.build = CacheDebounce(function(inst, req, res, cb) {
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
			if (!inst.user.resources) {
				return;
			}
			if (inst.existings && inst.existings[req.uri]) {
				// copy back because some of them won't have response because of the cache
				inst.user.depend(req.uri);
			}
			if (inst.reloads && inst.reloads[req.uri]) {
				req.headers['Cache-Control'] = 'no-cache';
			}
			if (ioreg && ioreg.test(URL.parse(req.uri).pathname)) {
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
				if (ioreg && ioreg.test(URL.parse(res.uri).pathname)) {
					if (type.is(res.mime, 'javascript') == false) inst.live = true;
				} else {
					var resource = raja.create(res.uri, res);
					inst.user.depend(resource);
					resource.save();

					// this covers the case where a resource finishes loading after idle
					if (inst.user.valid) {
						inst.user.itime = new Date();
						inst.user.valid = false;
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
				inst.user.save();
			}
		});
	}

	var _getView = Dom.Handler.prototype.getView;
	Dom.Handler.prototype.getView = function(req, cb) {
		var h = this;
		raja.upsert(h.view, function(err, resource) {
			if (err) return cb(err);
			h.view = resource;
			if (resource.valid) return cb();
			_getView.call(h, req, function(err) {
				if (err) return cb(err);
				h.view.save(cb);
			});
		});
	};

	var _getAuthored = Dom.Handler.prototype.getAuthored;
	Dom.Handler.prototype.getAuthored = function(inst, req, res, cb) {
		var h = this;
		raja.upsert(inst.author, function(err, resource) {
			if (err) return cb(err);
			inst.author = resource;
			if (!resource.headers) resource.headers = {};
			if (!resource.resources) resource.resources = {};
			if (resource.valid) return cb();
			_getAuthored.call(h, inst, req, res, function(err) {
				if (err) return cb(err);
				resource.headers['Content-Type'] = 'text/html';
				resource.depend(h.view);
				resource.save(cb);
			});
		});
	};

	var _getUsed = Dom.Handler.prototype.getUsed;
	Dom.Handler.prototype.getUsed = function(inst, req, res, cb) {
		var h = this;
		inst.user.headers = raja.headers(req);
		raja.upsert(inst.user, function(err, resource) {
			if (err) return cb(err);
			inst.user = resource;
			resource.headers['Content-Type'] = 'text/html';
			if (!resource.resources) resource.resources = {};
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
				if (!inst.opts) inst.opts = {};
				var sessionCookie = stealSession(req);
				if (sessionCookie) {
					inst.opts.cookies = sessionCookie;
				}
				_getUsed.call(h, inst, req, res, next);
			}
			function next(err) {
				if (err) return cb(err);
				if (inst.opts.cookies) delete inst.opts.cookies;
				if (inst.existings) delete inst.existings;
				if (inst.reloads) delete inst.reloads;
				if (!resource.itime || resource.itime <= resource.mtime) {
					resource.valid = true;
					resource.mtime = new Date();
				} else if (!resource.mtime) {
					resource.mtime = new Date();
				}
				updateGrants(resource, function(err) {
					// must be done at the very end, since the key varies on the resources grants
					if (err) return cb(err);
					var rights = req.get('X-Right');
					if (rights != resource.headers['X-Grant']) {
						console.warn('Permissions mismatch while accessing', resource.url, rights, resource.headers);
					}
					resource.save(cb);
				});
			}
		});
	};
}

function updateGrants(resource, cb) {
	var q = queue();
	var store = resource.raja.store;
	for (var key in resource.resources) {
		q.defer(store.get.bind(store), key);
	}
	q.awaitAll(function(err, resources) {
		if (err) return cb(err);
		var grants = mergeGrants({}, resource.headers);
		resources.forEach(function(item) {
			mergeGrants(grants, item.headers);
		});
		grants = Object.keys(grants);
		if (grants.length) {
			mergeHeader(resource.headers, 'Vary', 'X-Grant');
			resource.headers['X-Grant'] = grants.sort().join(',');
		} else {
			// update ?
		}
		cb();
	});
}

function mergeGrants(obj, headers) {
	var vary = headers.Vary;
	if (!vary || vary.split(',').indexOf('X-Grant') < 0) return obj;
	var header = headers['X-Grant'];
	if (!header) return obj;
	header.split(',').forEach(function(val) {
		obj[val.trim()] = true;
	});
	return obj;
}

function mergeHeader(headers, name, val) {
	var header = headers[name];
	header = header ? header.split(',') : [];
	if (header.indexOf(val) < 0) header.push(val);
	headers[name] = header.join(',');
}

function stealSession(req) {
	var session = req.session;
	var store = req.sessionStore;
	var opts = store.opts;
	// 1) generate a new session
	var decoy = {sessionStore: store};
	store.generate(decoy);
	// 2) give it same data
	for (var key in session) {
		if (decoy.session[key] != null || key == 'passport') continue;
		decoy.session[key] = session[key];
	}
	decoy.session.save();
	// 3) set that session cookie into inst.opts.cookies
	var cookieVal = decoy.sessionID;
	if (opts.secret) {
		cookieVal = 's:' + signature.sign(cookieVal, opts.secret);
	}
	var name = opts.name || opts.key || 'connect.sid';
	var cookieOpts = session.cookie.data;
	// webkitgtk must be able to set cookie using document.cookie
	if (cookieOpts.httpOnly) delete cookieOpts.httpOnly;
	return cookie.serialize(name, cookieVal, cookieOpts);
}

