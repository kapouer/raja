/*
 * raja browser client
 */
(function() {

if (!window.console) window.console = {};
if (!window.console.log) window.console.log = function() {};
if (!window.console.error) window.console.error = function() {};

var delayeds = {};

function Raja() {
	this.resources = {};

	// DOMContentLoaded happened ?
	this.domReady = false;
	// socket.io.js 0 no, 1 loading, 2 loaded
	this.ioReady = 0;
	// raja root exists ?
	this.root = null;
	// must connect to room ?
	this.room = null;
	// has ui ?
	this.ui = document.documentElement.offsetWidth || document.documentElement.offsetHeight;

	var self = this;
	this.events = {
		on: function(evt, listener) {
			delay('events', !!self.events._on, '_on', self.events, evt, listener);
			return self.events;
		},
		emit: function(what) {
			if (what == "error") {
				Function.prototype.apply.call(console.error, console, Array.prototype.slice.call(arguments, 1));
			}
		}
	};
	if (document.readyState == "interactive" || document.readyState == "completed") {
		this.domReady = true;
		self.ready();
	} else {
		document.addEventListener('DOMContentLoaded', documentLoaded, false);
	}
	function documentLoaded() {
		self.domReady = true;
		document.removeEventListener('DOMContentLoaded', documentLoaded, false);
		self.ready();
	}
}

function delay(name, now, func, self) {
	if (now) {
		if (typeof func == 'string') func = self[func];
		func.apply(self, Array.prototype.slice.call(arguments, 4));
	} else {
		if (!delayeds[name]) delayeds[name] = [];
		delayeds[name].push(Array.prototype.slice.call(arguments, 2));
	}
}

function undelay(name) {
	var list = delayeds[name];
	if (!list) return;
	delete delayeds[name];
	var item, func, self;
	for (var i=0; i < list.length; i++) {
		item = list[i];
		func = item.shift();
		self = item.shift();
		if (typeof func == 'string') func = self[func];
		func.apply(self, item);
	}
}

function loadRoot() {
	if (this.root) return;
	this.root = document.getElementById('raja');
	if (!this.root) return;
	this.pool = (this.root.getAttribute('data-client') || '').split(' ');
	this.namespace = this.root.getAttribute('data-namespace') || '';
	this.room = this.root.getAttribute('data-room');

	this.mtime = tryDate(this.root.getAttribute('data-last-modified')) || new Date();
	this.root.setAttribute('data-last-modified', this.mtime.getTime());
	var att = this.root.getAttribute('data-resources');
	var resources = att && JSON.parse(att) || {};
	for (var url in resources) {
		var resource = resources[url];
		resource.seen = true;
		resource.mtime = tryDate(resource.mtime);
		this.resources[url] = resource;
	}
	undelay('room');
}

Raja.prototype.ready = function() {
	// only called by raja script tag
	loadRoot.call(this);
	if (this.room && this.domReady) {
		undelay('loadDone');
		undelay('load');
	}
	checkConnect.call(this);
};

Raja.prototype.loadIo = function() {
	if (!this.pool) return;
	if (this.ioReady > 0) return;
	this.ioReady = 1;
	var self = this;
	var iojsUrl = randomEl(this.pool) + '/socket.io/socket.io.js';
	loadScript(iojsUrl, function(err) {
		if (err || !window.io) {
			if (self.loadTimeout) return;
			self.loadTimeout = setTimeout(function() {
				self.loadTimeout = null;
				self.ioReady = 0;
				self.loadIo();
			}, 1000);
			return;
		}
		self.ioReady = 2;

		var proto = window.io.Manager.prototype;

		self.events._on = proto.on;
		self.events.emit = proto.emit;
		self.events.off = proto.off;
		self.events.listeners = proto.listeners;
		undelay('events');

		self._on = proto.on;
		self._emit = proto.emit;
		self.off = proto.off;
		self.listeners = proto.listeners;
		undelay('on');
		undelay('emit');
		checkConnect.call(self);
	});
};

Raja.prototype.update = function() {
	var grants = {};
	var copies = {};

	for (var url in this.resources) {
		var resource = this.resources[url];
		var copy = {};
		if (resource.mtime) {
			copy.mtime = resource.mtime;
		}
		if (resource.cache && resource.data != undefined) {
			copy.data = resource.data;
		}
		if (resource.error !== undefined) {
			copy.error = {};
			['name', 'code', 'message'].forEach(function(key) {
				if (resource.error[key] != null) copy.error[key] = resource.error[key];
			});
		}
		copies[url] = copy;
		var grant = this.resources[url].grant || [];
		for (var i=0; i < grant.length; i++) {
			grants[grant[i]] = true;
		}
	}
	// because update is called independently of raja being in a configured state
	if (!this.root) {
		return;
	}
	this.root.setAttribute('data-resources', JSON.stringify(copies));

	var room = this.room;
	if (!room) return;
	var newroom = urlToKey(keyToUrl(room), grants);
	if (room.indexOf(newroom) < 0) {
		console.error("modifying original grants is not supported in this version of raja\n", room, "\nto\n", newroom);
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
	delay.apply(null, ['emits', !!this._emit, '_emit', this].concat(args));
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
	delay('room', this.room, doOn, this, url, opts, listener);
	return this;
};

function doOn(url, opts, listener) {
	this.loadIo();
	var plistener = function() {
		try {
			listener.apply(null, Array.prototype.slice.call(arguments));
		} catch(e) {
			self.events.emit('error', e);
		}
	};
	opts = reargs.call(this, resolve(url, keyToUrl(this.room)), opts);
	delay('on', this.ioReady == 2, '_on', this, opts.url, plistener);
	var once = this.once(opts.url, opts, function(err, data, meta) {
		if (err) return self.events.emit('error', err);
		plistener(data, meta);
		if (self.room && !self.io && self.ioReady == 2) checkConnect.call(self);
	});
	if (once && self.room && !self.io && self.ioReady == 2) checkConnect.call(this);
}

function checkConnect() {
	if (!this.room || this.io || this.ioReady != 2) return;
	for (var url in this.resources) {
		var resource = this.resources[url];
		if (!resource.error && !resource.mtime) {
			return;
		}
	}
	var self = this;
	setTimeout(function() {
		self.connect();
	}, 0);
}

Raja.prototype.many = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	opts.cache = true;
	this.load(url, opts, cb);
};

Raja.prototype.once = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	opts.once = true;
	this.load(url, opts, cb);
};

Raja.prototype.load = function(url, opts, cb) {
	if (!cb && typeof opts == "function") {
		cb = opts;
		opts = null;
	}
	if (!opts) opts = {};
	var self = this;
	if (!cb) cb = function(err) {
		if (err) self.events.emit('error', err);
	};

	delay('load', this.domReady && this.room, load, this, url, opts, cb);
};

function load(url, opts, cb) {
	opts = reargs.call(this, resolve(url, keyToUrl(this.room)), opts);
	var resources = this.resources;
	var resource = resources[opts.url];
	if (!resource) {
		resource = resources[opts.url] = {};
	} else if (opts.once) {
		if (resource.seen) return true;
	}
	resource.url = opts.url;
	if (resource.error) return cb(resource.error);
	if (opts.cache) resource.cache = true;
	if (resource.data !== undefined) return cb(null, resource.data);
	if (resource.callbacks) {
		// resource is currently loading
		resource.callbacks.push(cb);
		return {};
	}
	resource.callbacks = [cb];
	var self = this;
	var xhr = this.GET(opts.url, opts, function(err, obj) {
		if (err) {
			resource.error = err;
		} else {
			var grant = xhr.getResponseHeader("X-Grant");
			resource.grant = grant ? grant.split(',') : [];
			resource.mtime = tryDate(xhr.getResponseHeader("Last-Modified"));
			resource.data = obj;
		}
		delay('loadDone', self.domReady, loadDone, self, resource);
	});
}

function loadDone(resource) {
	this.update();
	for (var i=0; i < resource.callbacks.length; i++) {
		try {
			resource.callbacks[i](resource.error, resource.data, {
				mtime: resource.mtime,
				url: resource.url,
				method: 'get'
			});
		} catch(e) {
			console.error(e);
		}
	}
	delete resource.callbacks;
}

Raja.prototype.join = function() {
	this.io.emit('join', {
		room: this.room,
		mtime: this.mtime.getTime()
	});
};

Raja.prototype.connect = function() {
	if (this.io) return;
	var self = this;

	this.io = window.io(iouri());

	this.io.on('connect_error', function(e) {
		self.io.io.uri = iouri();
		self.events.emit('connect_error', e);
	});
	this.io.on('reconnect_error', function(attempts) {
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
	if (!opts) opts = {};
	if (opts.url) {
		// not twice, not without a room
		return opts;
	}
	var query;
	if (opts.query) {
		query = opts.query;
		delete opts.query;
	} else {
		query = {};
		for (var key in opts) {
			if ({type: 1, accept:1, cache: 1, once: 1, url: 1, headers: 1}[key]) continue;
			query[key] = opts[key];
		}
	}
	url = urlParams(url, query);
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
		for (var k in query) {
			var val = query[k];
			if (val && typeof val == "object") { // deal only with select elements here
				for (var i=0; i < val.length; i++) {
					comps.push({key: k, val: val[i]});
				}
			} else {
				comps.push({key: k, val: query[k]});
			}
		}
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
		}
		if (str && str[0] == "?") str = str.substring(1);
		var list = str.split('&');
		var obj = {}, pair, name, val;
		for (var i = 0; i < list.length; i++) {
			pair = list[i].split('=');
			if (!pair.length || !pair[0].length) continue;
			name = decodeURIComponent(pair[0]);
			val = pair[1] !== undefined ? decodeURIComponent(pair[1]) : null;
			if (obj[name]) {
				if (!obj[name].push) obj[name] = [obj[name]];
				obj[name].push(val);
			} else {
				obj[name] = val;
			}
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
		opts = reargs.call(this, resolve(url), opts);
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
