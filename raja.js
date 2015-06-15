/*
 * raja browser client
 */
(function() {

if (!window.console) window.console = {};
if (!window.console.log) window.console.log = function() {};
if (!window.console.error) window.console.error = function() {};

var INITIAL = 0;
var CONFIG = 1;
var LOADING = 2;
var LOADED = 3;

function Raja() {
	this.resources = {};
	this.state = INITIAL;
	var self = this;
	this.events = {
		on: function(evt, listener) {
			delay(self.events, evt, listener);
			return self.events;
		},
		emit: function(what) {
			if (what == "error") {
				Function.prototype.apply.call(console.error, console, Array.prototype.slice.call(arguments, 1));
			}
		}
	};
	this.ready();
}

function delay(obj) {
	if (!obj.delays) obj.delays = [];
	obj.delays.push(Array.prototype.slice.call(arguments, 1));
}

function undelay(obj) {
	if (!obj.delays) return;
	var list = obj.delays;
	delete obj.delays;
	for (var i=0; i < list.length; i++) {
		obj.on.apply(obj, list[i]);
	}
}

Raja.prototype.ready = function() {
	var self = this;
	if (this.state == INITIAL) {
		this.root = document.getElementById('raja');
		if (!this.root) return;
		this.state = CONFIG;
		this.pool = (this.root.getAttribute('data-client') || '').split(' ');
		this.namespace = this.root.getAttribute('data-namespace') || '';
		this.room = this.root.getAttribute('data-room');
		if (!this.room) throw new Error("Raja cannot connect without a room url");
	}

	var lastMod = this.root.getAttribute('data-last-modified');
	var now = new Date();
	if (!lastMod) {
		// work around webkit bug https://bugs.webkit.org/show_bug.cgi?id=4363
		lastMod = Date.parse(document.lastModified);
		var diff = (new Date(now.toLocaleString())).getTimezoneOffset() - now.getTimezoneOffset();
		if (!diff) diff = now.getTimezoneOffset() * 60000;
		else diff = 0;
		lastMod = lastMod - diff;
	}

	this.mtime = tryDate(lastMod) || now;
	this.root.setAttribute('data-last-modified', this.mtime.getTime());
	var att = this.root.getAttribute('data-resources');
	var resources = att && JSON.parse(att) || {};
	for (var url in resources) {
		var resource = resources[url];
		resource.seen = true;
		resource.mtime = tryDate(resource.mtime);
		this.resources[url] = resource;
	}
};

Raja.prototype.init = function() {
	if (this.state != CONFIG) return;
	this.state = LOADING;
	var self = this;
	var iojsUrl = randomEl(this.pool) + '/socket.io/socket.io.js';
	loadScript(iojsUrl, function(err) {
		if (err || !window.io) {
			console.error("Error loading", iojsUrl);
			if (self.loadTimeout) return;
			self.loadTimeout = setTimeout(function() {
				self.loadTimeout = null;
				self.state = CONFIG;
				self.init();
			}, 1000);
			return;
		}
		self.state = LOADED;

		var proto = window.io.Manager.prototype;

		self._on = proto.on;
		self._emit = proto.emit;
		self.off = proto.off;
		self.listeners = proto.listeners;
		undelay(self);

		self.events.on = proto.on;
		self.events.emit = proto.emit;
		self.events.off = proto.off;
		self.events.listeners = proto.listeners;
		undelay(self.events);
	});
};

Raja.prototype.update = function() {
	var grants = {};
	var copies = {};

	for (var url in this.resources) {
		var resource = this.resources[url];
		var copy = {};
		if (resource.mtime) copy.mtime = resource.mtime;
		if (resource.cache && resource.data != undefined) copy.data = resource.data;
		copies[url] = copy;
		var grant = this.resources[url].grant || [];
		for (var i=0; i < grant.length; i++) {
			grants[grant[i]] = true;
		}
	}
	// because update is called independently of raja being in a configured state
	if (!this.root) return;
	this.root.setAttribute('data-resources', JSON.stringify(copies));

	var room = this.room;
	if (!room) return;
	var newroom = urlToKey(keyToUrl(room), grants);
	if (room.indexOf(newroom) < 0) {
		console.error("modifying original grants is not supported in this version of raja\n", room, "\nto\n", newroom);
		return;
		/*
		this.root.setAttribute('data-room', newroom);
		this.room = newroom;
		if (this.io) {
			this.io.emit('leave', { room: room });
			this.join();
		}
		*/
	}
};

Raja.prototype.emit = function(what) {
	if (!what) throw new Error("Missing event for raja.emit");
	var args = Array.prototype.slice.call(arguments, 0);
	args[0] = this.resolve(what, keyToUrl(this.room));
	try {
		this._emit.apply(this, args);
	} catch(e) {
		console.error(e);
	}
};

Raja.prototype.on = function(url, opts, listener) {
	var self = this;
	if (!listener && typeof opts == "function") {
		listener = opts;
		opts = null;
	}
	if (!listener) {
		throw new Error("Missing listener for raja.on");
	}

	if (this.state != LOADED) {
		if (this.state == CONFIG) this.init();
		delay(this, url, opts, listener);
		return this;
	}

	var plistener = function() {
		try {
			listener.apply(null, Array.prototype.slice.call(arguments));
		} catch(e) {
			self.events.emit('error', e);
		}
	};
	opts = reargs.call(this, url, opts);

	this._on(opts.url, plistener);

	var once = this.once(opts.url, opts, function(err, data, meta) {
		if (err) return self.events.emit('error', err);
		plistener(data, meta);
		if (self.io) return;
		onDone.call(self);
	});
	if (once) onDone.call(self);
	return this;
};

function onDone() {
	for (var url in this.resources) {
		var resource = this.resources[url];
		if (!resource.error && !resource.mtime) {
			return;
		}
	}
	var self = this;
	setTimeout(function() {
		if (!self.io) self.connect();
	}, 1);
}

Raja.prototype.many = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	opts = reargs.call(this, url, opts);
	opts.cache = true;
	return this.load(opts.url, opts, cb);
};

Raja.prototype.once = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	opts = reargs.call(this, url, opts);
	opts.once = true;
	return this.load(opts.url, opts, cb);
};

Raja.prototype.load = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	opts = reargs.call(this, url, opts);
	var self = this;
	if (!cb) cb = function(err) {
		if (err) self.events.emit('error', err);
	};
	var resources = this.resources;
	var resource = resources[opts.url];
	if (!resource) resource = resources[opts.url] = {};
	else if (opts.once && resource.seen) return true;
	if (resource.error) return cb(resource.error);
	if (opts.cache) resource.cache = true;
	if (resource.data !== undefined) return cb(null, resource.data);
	if (resource.callbacks) {
		// resource is currently loading
		resource.callbacks.push(cb);
		return {};
	}
	resource.callbacks = [cb];
	var xhr = this.GET(opts.url, opts, function(err, obj) {
		if (err) {
			resource.error = err;
			return done(err);
		}
		var mtime = tryDate(xhr.getResponseHeader("Last-Modified"));
		var grant = xhr.getResponseHeader("X-Grant");
		resource.grant = grant ? grant.split(',') : [];
		resource.mtime = mtime;
		resource.data = obj;
		done(null, obj);
	});
	function done(err, data) {
		self.update();
		for (var i=0; i < resource.callbacks.length; i++) {
			try {
				resource.callbacks[i](err, data, {mtime: resource.mtime, url: opts.url, method: 'get'});
			} catch(e) {
				console.error(e);
			}
		}
		delete resource.callbacks;
	}
};

Raja.prototype.join = function() {
	this.io.emit('join', {
		room: this.room,
		mtime: this.mtime.getTime()
	});
};

Raja.prototype.connect = function() {
	var self = this;

	this.io = window.io(iouri());

	this.io.on('connect_error', function(e) {
		self.io.io.uri = iouri();
		self.events.emit('connect_error', e);
	});
	this.io.on('reconnect_error', function(attemps) {
		self.io.io.uri = iouri();
		self.events.emit('reconnect_error', attempts);
	});
	this.io.on('connect', function() {
		self.join();
		self.events.emit('connect');
	});
	this.io.on('message', function(msg) {
		if (!msg.key) return;
		var data = msg.data;
		if (data) delete msg.data;
		var stamp = msg.mtime;
		var mtime = tryDate(stamp);
		if (mtime) msg.mtime = mtime;
		var fresh = msg.mtime > self.mtime;
		if (fresh) {
			self.mtime = msg.mtime;
			self.root.setAttribute('data-last-modified', stamp);
		}
		var parents = msg.parents;
		parents.unshift(msg.key);
		var selfUrl = keyToUrl(self.room);
		for (var i=0; i < parents.length; i++) {
			var url = keyToUrl(parents[i]);
			var resource = self.resources[url];
			if (resource) {
				if (!resource.mtime || msg.mtime > resource.mtime) resource.mtime = msg.mtime;
				self.emit(url, data, msg);
			} else if (fresh && url != selfUrl) {
				// some dependency that isn't a resource - a static file ? - has changed
			}
		}
	});
	function iouri() {
		var iohost = randomEl(self.pool);
		if (iohost.substring(0, 2) == '//') iohost = document.location.protocol + iohost;
		return iohost + '/' + self.namespace;
	}
};

function reargs(url, opts) {
	var query;
	if (!opts) opts = {};
	if (opts.url) {
		// do not rearg twice
		return opts;
	}
	if (opts.query) {
		query = opts.query;
		delete opts.query;
	} else if (!opts.type && !opts.accept && opts.cache == undefined && opts.once == undefined) {
		query = opts;
	}
	url = urlParams(url, query);
	url = resolve(url, keyToUrl(this.room));
	var str = this.query.stringify(query);
	if (str) {
		url += url.indexOf('?') > 0 ? '&' : '?';
		url += str;
	}
	opts.url = url;
	return opts;
}

function randomEl(arr) {
	var index = parseInt(Math.random() * arr.length);
	return arr[index];
}

function parseUrl(url) {
	var ta = document.createElement('a');
	ta.setAttribute('href', url);
	ta.setAttribute('href', ta.href); // IE <= 10
	var loc = {
		href: ta.href,
		protocol: ta.protocol ? ta.protocol.replace(/:$/, '') : '',
		host: ta.host,
		search: ta.search ? ta.search.replace(/^\?/, '') : '',
		hash: ta.hash ? ta.hash.replace(/^#/, '') : '',
		hostname: ta.hostname,
		port: ta.port,
		pathname: ta.pathname.charAt(0) == '/' ? ta.pathname : '/' + ta.pathname
	};
	if (loc.search) loc.search = '?' + loc.search;
	if (loc.hash) loc.hash = '#' + loc.hash;
	if (loc.protocol) loc.protocol += ':';
	return loc;
}
Raja.prototype.parseUrl = parseUrl;

function resolve(url, rel) {
	if (!rel) rel = document.location;
	if (window.URL) {
		if (typeof rel == "string") rel = new window.URL(rel, document.location);
		var rurl = new window.URL(url, rel);
		return rurl.pathname + rurl.search;
	}
	if (typeof rel == "string") rel = parseUrl(rel);
	var loc = parseUrl(url);
	// do not resolve incomparable url
	if (loc.protocol != rel.protocol || loc.host != rel.host) return url;
	// do not resolve url if it isn't relative
	var path = loc.pathname + loc.search;
	if (path == url || loc.href == url || loc.protocol + url == loc.href) return path;
	pathname = rel.pathname + '/../' + url;
	return parseUrl(pathname).pathname + loc.search;
}
Raja.prototype.resolve = resolve;

function urlParams(url, params) {
	if (!params) return url;
	return url.replace(/\/:(\w+)/g, function(str, name) {
		var val = params[name];
		if (val != null) {
			delete params[name];
			return '/' + val;
		} else {
			return '/:' + name;
		}
	});
}
Raja.prototype.urlParams = urlParams;

Raja.prototype.query = {
	stringify: function(query) {
		var comps = [];
		for (var k in query) comps.push({key: k, val: query[k]});
		comps.sort(function(a, b) {
			if (a.key < b.key) return 1;
			else if (a.key > b.key) return -1;
			else return 0;
		});
		var str, list = [];
		for (var i=0; i < comps.length; i++) {
			str = encodeURIComponent(comps[i].key);
			if (comps[i].val != null) str += '=' + encodeURIComponent(comps[i].val);
			list.push(str);
		}
		if (list.length) return list.join('&');
		else return '';
	},
	parse: function(str) {
		if (str == undefined) {
			str = document.location.search;
			if (str && str[0] == "?") str = str.substring(1);
		}
		var list = str.split('&');
		var obj = {}, pair;
		for (var i = 0; i < list.length; i++) {
			pair = list[i].split('=');
			if (!pair.length || !pair[0].length) continue;
			obj[decodeURIComponent(pair[0])] = pair[1] !== undefined ? decodeURIComponent(pair[1]) : null;
		}
		return obj;
	}
};

for (var method in {GET:1, PUT:1, POST:1, DELETE:1}) {
	Raja.prototype[method] = (function(method) { return function(url, opts, body, cb) {
		var self = this;
		if (!url) throw new Error("Missing url in raja." + method);
		if (!cb) {
			if (typeof body == "function") {
				cb = body;
				body = null;
			} else if (typeof opts == "function") {
				cb = opts;
				opts = null;
			}
			if (!cb) cb = function(err) {
				if (err) self.events.emit('error', err);
			};
		}

		if (/^(HEAD|GET|COPY)$/i.test(method) == false) {
			// give priority to body
			if (!body && opts) {
				body = opts;
				opts = null;
			}
		}
		opts = reargs.call(this, url, opts);
		var type = opts.type || 'json';
		var accept = opts.accept || [
			'application/json; q=1.0',
			'text/javascript; q=1.0',
			'application/xml; q=0.9',
			'text/xml; q=0.9',
			'text/plain; q=0.8',
			'text/html; q=0.7'
		];
		if (typeof accept != "string" && accept.join) accept = accept.join(',');

		var xhr = new XMLHttpRequest();
		xhr.open(method, opts.url, true);
		xhr.onreadystatechange = function(e) {
			if (this.readyState == 4) {
				var code = this.status;
				if (!code) {
					var err = new Error("xhr cancelled " + opts.url);
					err.code = 0;
					return cb(err);
				}
				var response, ex;
				if (this.responseType == "json") {
					try { response = this.response; } catch(e) { ex = e; }
				}
				if (!response) {
					try { response = this.responseXML; } catch(e) { ex = e; }
				}
				if (!response) {
					try { response = tryJSON(this.responseText); } catch(e) { ex = e; }
				}

				if (code >= 200 && code < 400) {
					cb(null, response);
				} else {
					var err = new Error(response || ex || "unreadable response");
					err.code = code;
					cb(err);
				}
			}
		};
		xhr.setRequestHeader('Accept', accept);
		if (type == "html") {
			// response will contain a document
			xhr.responseType = "document";
		}
		if (body) {
			var contentType = {
				text: 'text/plain',
				json: 'application/json',
				xml: 'application/xml',
				html: 'text/html',
				form: 'application/x-www-form-urlencoded',
				multipart: 'multipart/form-data'
			}[type];
			if (contentType) xhr.setRequestHeader('Content-Type', contentType);
			if (type == 'json') body = JSON.stringify(body);
			xhr.send(body);
		} else {
			xhr.send();
		}
		return xhr;
	};})(method);
}

function loadScript(url, cb) {
	var script = document.createElement("script");
	script.async = true;
	script.type = 'text/javascript';
	script.charset = 'utf-8';
	script.src = url;
	function done() {
		script.onload = null;
		script.onerror = null;
		if (script.parentNode) {
			script.parentNode.removeChild(script);
		}
		script = null;
	}
	script.onload = function() {
		done();
		cb();
	};
	script.onerror = function(e) {
		done();
		cb(e);
	};
	// Circumvent IE6 bugs with base elements
	document.head.insertBefore(script, document.head.firstChild);
}
Raja.prototype.loadScript = loadScript;

function tryJSON(txt) {
	var obj;
	try {
		obj = JSON.parse(txt);
	} catch(e) {
		return txt;
	}
	return obj;
}

function tryDate(txt) {
	if (!txt) return;
	if (typeof txt == "string") {
		var num = parseInt(txt);
		if (!isNaN(num) && num.toString().length == txt.length) txt = num;
	}
	var date = new Date(txt);
	var time = date.getTime();
	if (isNaN(time)) return;
	else return date;
}

function keyToUrl(key) {
	if (!key) return key;
	var arr = key.split(" ");
	if (arr.length > 1) {
		arr.shift();
		return arr.join(" ");
	} else {
		return key;
	}
}

function urlToKey(url, grants) {
	var list = [];
	for (var grant in grants) {
		list.push(grant);
	}
	if (!list.length) return url;
	else return "right=" + encodeURIComponent(list.join(',')) + " " + url;
}

window.raja = new Raja();

})();
