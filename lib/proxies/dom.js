var URL = require('url');
var queue = require('queue-async');
var typeis = require('type-is').is;
var agent = require('../utils/agent');
var debug = require('debug')('raja:dom');
var CacheDebounce = require('cache-debounce');

module.exports = DomProxy;

function DomProxy(raja, opts) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, opts);
	this.raja = raja;
	var Dom = this.Dom = opts.dom;

	var ioreg;
	var iopath = raja.io && raja.io.socket && raja.io.socket.io.opts.path;
	if (iopath) ioreg = new RegExp("^" + iopath);

	Dom.settings.allow = "all";
	Dom.settings.verbose = true;

	var self = this;

	Dom.use(domRajaMeta, 'before');

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

	var _buildAuthored = Dom.Handler.prototype.buildAuthored;
	Dom.Handler.prototype.buildAuthored = CacheDebounce(function(resource, view, url, req, res, cb) {
		_buildAuthored.call(this, resource, view, url, req, res, cb);
	}, function(resource) {
		return resource.key;
	});

	var _buildUsed = Dom.Handler.prototype.buildUsed;
	Dom.Handler.prototype.buildUsed = CacheDebounce(function(resource, author, url, req, res, cb) {
		_buildUsed.call(this, resource, author, url, req, res, cb);
	}, function(resource) {
		return resource.key;
	});

	Dom.author(domResponsePlugin, 'before');
	Dom.use(domResponsePlugin, 'before');
	Dom.use(domUserPlugin, 'before');
	Dom.use(domDonePlugin, 'after');

	function listener(msg) {
		var h = this;
		var reload = false;
		var lastKey = msg.parents.slice(-1).pop();
		msg.parents.forEach(function(key) {
			raja.store.get(key, function(err, resource) {
				if (err) return raja.error(err);
				if (!resource) return;
				if (msg.key == key && msg.mtime > resource.mtime && (!resource.itime || msg.mtime > resource.itime)) {
					resource.itime = msg.mtime;
					if (resource.page) resource.page.pingTime = Date.now();
				}
				var contentType = resource.headers && resource.headers['Content-Type'];
				if (lastKey != resource.key && contentType && (typeis(contentType, '*/javascript') || typeis(contentType, 'text/html'))) {
					debug("Detected change in", key);
					reload = true;
				}
				if (reload && resource.page && !resource.page.locked) { // avoid multiple releases at once
					debug("Detected change in page dependencies, releasing it", resource.key);
					Dom.pool.release(resource.page);
				}
			});
		});
	}

	function domRajaMeta(page, resource, req, res) {
		page.when('ready', function(cb) {
			this.run(function(key, client, ns, done) {
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
			}, resource.key, opts.client, opts.namespace, cb);
		});
	}

	function domResponsePlugin(page, resource) {
		var host = URL.parse(resource.url).host;
		page.on('response', function(res) {
			if (!res.uri || res.uri == "about:blank") return;
			if (res.uri == resource.url) return; // ignore self
			if (!resource.resources) return;
			if (res.status < 200 || res.status >= 400) return;
			var uriObj = URL.parse(res.uri);
			if (ioreg && ioreg.test(uriObj.pathname)) {
				if (typeis(res.mime, 'javascript') == false) resource.live = true;
				return;
			}
			var headers = raja.headers(res);
			if (host == uriObj.host) {
				headers['X-Raja'] = raja.opts.namespace;
			}
			resource.depend(raja.create(res.uri, headers));
			// this covers the case where a resource finishes loading after idle
			if (resource.valid) {
				resource.itime = new Date();
				resource.valid = false;
				resource.save();
			}
		});
	}

	function domUserPlugin(page, resource) {
		var host = URL.parse(resource.url).host;
		page.filters.push([function(pool, ioreg) {
			var uriObj = new URL(this.uri);
			if (pool.some(function(obj) {
				if (obj.host == uriObj.host) return true;
			})) {
				if (ioreg && ioreg.test(uriObj.pathname)) {
					// ignore io request
					this.ignore = true;
				}
			} else if (uriObj.host != document.location.host) {
				// reject foreign hosts
				this.cancel = true;
			} else {
				this.headers['Cache-Control'] = 'no-cache';
			}
		}, raja.client && raja.client.pool || [], ioreg]);
		page.on('busy', function() {
			if (resource.itime && resource.itime > resource.mtime) {
				debug("busy page invalidates resource", resource.key);
				delete resource.itime;
				// update resources to make sure instances loaded on server receive messages
				resource.valid = false;
				resource.save();
			}
		});
	}

	function domDonePlugin(page, resource, req, res) {
		var output = resource.output;
		resource.output = function(page, cb) {
			resource.output = output;
			if (!resource.itime || resource.itime <= resource.mtime) {
				resource.valid = true;
				resource.mtime = new Date();
			} else if (!resource.mtime) {
				resource.mtime = new Date();
			}
			output.call(resource, page, cb);
		};
	}

	var _get = Dom.Handler.prototype.get;
	Dom.Handler.prototype.get = function(url, depend, havingHeaders, cb) {
		if (!cb) {
			cb = havingHeaders;
			havingHeaders = null;
		}
		if (!cb) {
			cb = depend;
			depend = null;
		}
		var obj = {url: url, builder: 'dom'};
		if (havingHeaders) obj.headers = raja.headers(havingHeaders);
		else obj.headers = {};
		obj.headers['X-Raja'] = opts.namespace;
		debug('get', obj);
		raja.upsert(obj, function(err, resource) {
			if (err) return cb(err);
			if (!resource.headers) resource.headers = {};
			if (!resource.resources) resource.resources = {};
			if (depend) resource.depend(depend);
			if (!resource.output) resource.output = function(page, cb) {
				if (!page) return cb(new Error("resource.page was unset before output of\n" + resource.key));
				page.when('idle', function(wcb) {
					page.pingTime = Date.now();
					this.html(function(err, str) {
						cb(err, str);
						wcb();
					});
				});
			};
			cb(null, resource);
		});
	};
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
	if (!store) return;
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

