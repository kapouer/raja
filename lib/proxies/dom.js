var URL = require('url');
var queue = require('queue-async');
var CacheDebounce = require('cache-debounce');
var typeis = require('type-is').is;
var agent = require('../utils/agent');
var debug = require('debug')('raja:dom');
require('debug').enable('webkitgtk:stall');

module.exports = DomProxy;

function DomProxy(raja, opts) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, opts);
	this.raja = raja;
	var Dom = this.Dom = opts.dom;

	var ioreg;

	var self = this;

	Dom.use(domProxyPluginMeta, 'before');

	if (opts.disable) return;

	Dom.Handler.prototype.init = function() {
		this.opts.params = stealSession;
		this.listener = listener.bind(this);
		raja.on('message', this.listener);
	};

	var _finish = Dom.Handler.prototype.finish;
	Dom.Handler.prototype.finish = function(user, res) {
		res.set('X-Raja', opts.namespace);
		for (var name in user.headers) {
			if (name in {'Vary': 1, 'X-Grant': 1, 'ETag': 1}) {
				res.set(name, user.headers[name]);
			}
		}
		_finish.call(this, user, res);
	};

	Dom.Handler.prototype.loadLocal = raja.proxies.local.get.bind(raja.proxies.local);

	Dom.Handler.prototype.loadRemote = function(url, opts, cb) {
		raja.proxies.remote.get(url, opts, function(err, res) {
			cb(err, res && res.data);
		});
	};

	Dom.author(domProxyPlugin, 'before');
	Dom.use(domProxyPlugin, 'before');
	Dom.use(domProxyBusyPlugin, 'before');
	Dom.use(domProxyDonePlugin, 'after');

	function listener(msg) {
		var h = this;
		var reload = false;
		msg.parents.forEach(function(key) {
			raja.store.get(key, function(err, resource) {
				if (err) return raja.error(err);
				if (!resource) return;
				if (msg.key == key && msg.mtime > resource.mtime && (!resource.itime || msg.mtime > resource.itime)) {
					resource.itime = msg.mtime;
				}
				if (resource.page && reload) {
					debug("Detected change releases page", resource.key);
					Dom.pool.release(resource.page);
				}
				var contentType = resource.headers && resource.headers['Content-Type'];
				if (contentType && (typeis(contentType, '*/javascript') || typeis(contentType, 'text/html'))) {
					debug("Detected change in", key);
					reload = true;
				}
			});
		});
	}

	function domProxyPluginMeta(page, resource, req, res) {
		page.wait('ready').run(function(key, client, ns, done) {
			var node = document.getElementById('script');
			if (!node) node = document.createElement('script');
			node.id = 'raja';
			node.setAttribute('data-client', client);
			node.setAttribute('data-namespace', ns);
			node.setAttribute('data-room', key);
			node.type = "text/javascript";
			node.textContent = "(function(r) {if (r && r.ready) r.ready();})(window.raja);";
			if (!node.parentNode) {
				var tn = document.createTextNode("\n");
				document.head.insertBefore(node, document.head.firstChild);
				document.head.insertBefore(tn, node);
			}
			done();
		}, [resource.key, opts.client, opts.namespace]);
	}

	function domProxyPlugin(page, resource) {
		page.on('unload', function() {}); // keep it running !
		page.on('error', raja.error.bind(raja));
		page.on('request', function(req) {
			if (!resource.resources) {
				return;
			}
//			if (resource.existings && resource.existings[req.uri]) {
//				// copy back because some of them won't have response because of the cache
//				resource.depend(req.uri);
//			}

			req.headers['Cache-Control'] = 'no-cache';

			if (ioreg && ioreg.test(URL.parse(req.uri).pathname)) {
				req.ignore = true;
			}
		});
		page.on('response', function(res) {
			if (!res.uri || res.uri == "about:blank") return;
			if (res.uri == resource.url) return; // ignore view and author
			if (!resource.resources) return;
			if (res.status >= 200 && res.status < 400) {
				if (!ioreg) {
					var iopath = raja.io && raja.io.socket && raja.io.socket.io.opts.path;
					if (iopath) ioreg = new RegExp("^" + iopath);
				}
				if (ioreg && ioreg.test(URL.parse(res.uri).pathname)) {
					if (typeis(res.mime, 'javascript') == false) resource.live = true;
				} else {
					var child = raja.create(res.uri, res);
					resource.depend(child);

					// this covers the case where a resource finishes loading after idle
					if (resource.valid) {
						resource.itime = new Date();
						resource.valid = false;
						resource.save();
					}
				}
			}
		});
	}

	function domProxyBusyPlugin(page, resource) {
		page.on('busy', function() {
			if (resource.itime && resource.itime > resource.mtime) {
				delete resource.itime;
				// update resources to make sure instances loaded on server receive messages
				resource.valid = false;
				resource.save();
			}
		});
	}

	function domProxyDonePlugin(page, resource, req, res) {
		var output = resource.output;
		resource.output = function(page, cb) {
			resource.output = output;
			if (!resource.itime || resource.itime <= resource.mtime) {
				resource.valid = true;
				resource.mtime = new Date();
			} else if (!resource.mtime) {
				resource.mtime = new Date();
			}
			updateGrants(resource, function(err) {
				// must be done at the very end, since the key varies on the resources grants
				if (err) return cb(err);
				if (req.headers['X-Right'] != resource.headers['X-Grant']) {
					console.warn(
						'Permissions mismatch while accessing',
						resource.url,
						'X-Right', req.headers['X-Right'],
						'X-Grant', resource.headers['X-Grant']
					);
				}
				output.call(resource, page, cb);
			});
		};
	}

	var _get = Dom.Handler.prototype.get;
	Dom.Handler.prototype.get = function(url, depend, req, cb) {
		if (!cb) {
			cb = req;
			req = null;
		}
		if (!cb) {
			cb = depend;
			depend = null;
		}
		var obj = {url: url, builder: 'dom'};
		if (req) obj.headers = raja.headers(req);
		else obj.headers = {};
		// must copy X-Right headers because express proxy sets them on response,
		// but response hasn't been completed yet and it's better to do it before
		// resource instantiation or else it leads to duplication when promoting
		// the resource and this isn't well supported - it leads to page stealing
		// and crashes
		var rights = obj.headers['X-Right'];
		rights = rights ? rights.split(',') : [];
		debug('initial resource rights', obj.url, rights);
		if (rights.length) {
			mergeHeader(obj.headers, 'Vary', 'X-Grant');
			obj.headers['X-Grant'] = rights.sort().join(',');
		}
		debug('get', obj);
		raja.upsert(obj, function(err, resource) {
			if (err) return cb(err);
			if (!resource.headers) resource.headers = {};
			if (!resource.resources) resource.resources = {};
			if (depend) resource.depend(depend);
			if (!resource.output) resource.output = function(page, cb) {
				if (!page) return cb(new Error("resource.page was unset before output of\n" + resource.key));
				page.html(cb);
			};
			cb(null, resource);
		});
	};
}

function updateGrants(resource, cb) {
	var q = queue();
	var grants = mergeGrants({}, resource.headers);
	var store = resource.raja.store;
	for (var key in resource.resources) {
		q.defer(store.get.bind(store), key);
	}
	q.awaitAll(function(err, resources) {
		if (err) return cb(err);
		resources.forEach(function(item) {
			if (item) mergeGrants(grants, item.headers);
		});
		grants = Object.keys(grants);
		if (grants.length) {
			mergeHeader(resource.headers, 'Vary', 'X-Grant');
			resource.headers['X-Grant'] = grants.sort().join(',');
		} else {
			delete resource.headers['X-Grant'];
		}
		cb();
	});
}

function mergeGrants(obj, headers) {
	var vary = headers.Vary;
	if (!vary || vary.split(',').indexOf('X-Grant') < 0) return obj;
	var header = headers['X-Grant'];
	if (!header) return obj;
	debug('merge grants', header);
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

function stealSession(opts, req) {
	var session = req.session;
	var store = req.sessionStore;
	// 1) generate a new session
	var decoy = {sessionStore: store};
	store.generate(decoy);
	// 2) give it same data
	for (var key in session) {
		if (decoy.session[key] != null || key == 'passport') continue;
		decoy.session[key] = session[key];
	}
	decoy.session.save();
	debug("hosted session", decoy.sessionID, decoy.session);
	// 3) set that session cookie into opts.cookies
	opts.cookies = agent.sessionCookie(req, decoy.sessionID, true);
}

