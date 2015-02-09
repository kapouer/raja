/*
 * raja browser client
 */
(function() {

window.raja = new Raja();

loadScript('/socket.io/socket.io.js', function(err) {
	if (err) throw err;
	var proto = io.Manager.prototype;
	raja._on = proto.on;
	raja._emit = proto.emit;
	raja.off = proto.off;
	raja.listeners = proto.listeners;
	raja.ready();
});

function Raja() {
	this.delays = [];
	this.base = document.getElementById('raja-io').content;
}

Raja.prototype.delay = function(url, query, listener) {
	this.delays.push([url, query, listener]);
	return this;
};

Raja.prototype.ready = function() {
	this.url = absolute(document.location, '.');
	// work around webkit bug https://bugs.webkit.org/show_bug.cgi?id=4363
	var lastMod = Date.parse(document.lastModified);
	var now = new Date();
	var diff = (new Date(now.toLocaleString())).getTimezoneOffset() - now.getTimezoneOffset();
	if (!diff) diff = now.getTimezoneOffset() * 60000;
	else diff = 0;
	lastMod = lastMod - diff;
	this.mtime = isNaN(lastMod) ? now : new Date(lastMod);
	this.resources = {};
	var links = document.head.querySelectorAll('link[rel="resource"]');
	for (var i=0; i < links.length; i++) {
		var link = links.item(i);
		this.resources[link.href] = {url: link.href, mtime: this.mtime};
	}
	var list = this.delays;
	delete this.delays;
	for (var i=0; i < list.length; i++) {
		this.on.apply(this, list[i]);
	}
};

Raja.prototype.link = function(url) {
	var link = $('head > link[rel="resource"][href="'+url+'"]');
	if (link) return;
	link = document.createElement('link');
	link.rel = "resource";
	link.href = url;
	var tn = document.createTextNode("\n");
	document.head.insertBefore(link, document.head.firstChild);
	document.head.insertBefore(tn, link);
};

Raja.prototype.emit = function(what) {
	var args = Array.prototype.slice.call(arguments, 0);
	try {
		this._emit.apply(this, args);
	} catch(e) {
		console.error(e);
	}
	if (what == "error" && this.listeners("error").length == 0) {
		args.shift();
		console.error.apply(console, args);
	}
};

Raja.prototype.on = function(url, query, listener) {
	if (!listener && typeof query == "function") {
		listener = query;
		query = null;
	}
	if (!this.resources) {
		return this.delay(url, query, listener);
	}
	if (!this.io) this.setio();
	var self = this;
	if (url == "error") return this._on(url, listener);
	var plistener = function() {
		try {
			listener.apply(null, Array.prototype.slice.call(arguments));
		} catch(e) {
			self.emit('error', e);
		}
	};
	url = absolute(document.location, url);
	url = urlQuery(url, query);
	this._on(url, plistener);
	var resources = this.resources;
	var resource = resources[url];
	if (!resource) resource = resources[url] = {url: url};
	if (resource.error) return;

	(function(next) {
		var reqs = resource.requests;
		if (resource.data !== undefined) {
			listener(resource.data, {
				method:"get",
				url: url,
				mtime: resource.mtime
			});
			return next();
		} else if (resource.mtime !== undefined) {
			// resource merged, just join it
			return next();
		} else if (resource.queue) {
			// resource is currently loading
			resource.queue.push(listener);
			return;
		}
		// resource has not been loaded, is not loading. Proceed
		resource.queue = [listener];
		var xhr = Raja.prototype.GET(url, function(err, obj) {
			if (err) {
				resource.error = err;
				return next(err);
			}
			var mtime = tryDate(xhr.getResponseHeader("Last-Modified"));
			self.link(url);
			resource.mtime = mtime;
			resource.data = obj;
			for (var i=0; i < resource.queue.length; i++) {
				try {
					resource.queue[i](obj, {
						method:"get",
						url: url,
						query: query,
						mtime: mtime
					});
				} catch(e) {
					console.error(e);
				}
			}
			delete resource.queue;
			next();
		});
	})(function(err) {
		if (err) self.emit('error', err);
	});
	return this;
};

Raja.prototype.setio = function() {
	this.io = io(this.base);
	var self = this;
	this.io.on('reconnect_failed', function(err) {
		if (err) self.emit('error', err);
	});
	this.io.emit('join', {
		room: this.url,
		mtime: this.mtime.getTime()
	});

	this.io.on('message', function(msg) {
		if (!msg.url) return;
		var data = msg.data;
		if (data) delete msg.data;
		var mtime = tryDate(msg.mtime);
		if (mtime) msg.mtime = mtime;
		var fresh = msg.mtime > self.mtime;
		if (fresh) {
			self.mtime = msg.mtime;
		}
		var parents = msg.parents;
		parents.unshift(msg.url);
		for (var i=0; i < parents.length; i++) {
			var url = parents[i];
			var resource = self.resources[url];
			if (resource) {
				if (!resource.mtime || msg.mtime > resource.mtime) resource.mtime = msg.mtime;
				self.emit(url, data, msg);
			} else if (fresh && url != self.url) {
				// some dependency that isn't a resource - a static file ? - has changed
			}
		}
	});
};

function absolute(loc, url) {
	if (/^https?/i.test(url)) return url;
	var path = loc.pathname;
	if (url.indexOf('..') == 0) {
		path = path.split('/');
		path.pop();
		url = path.join('/') + url.substring(2);
	} else if (url == '.') {
		 return loc.href;
	} else if (url.indexOf('.') == 0) {
		url = path + url.substring(1);
	} else if (url.indexOf('/') != 0) {
		var base = path.split('/');
		base.pop();
		base = base.join('/');
		url = base + '/' + url;
	}
	url = loc.protocol + '//' + loc.host + url;
	return url;
}
Raja.prototype.absolute = absolute;

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

function urlQuery(url, query) {
	if (!query) return url;
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
	if (list.length) {
		if (url.indexOf('?') > 0) url += '&';
		else url += '?';
		url += list.join('&');
	}
	return url;
}
Raja.prototype.urlQuery = urlQuery;

for (var method in {GET:1, PUT:1, POST:1, DELETE:1}) {
	Raja.prototype[method] = (function(method) { return function(url, query, body, cb) {
		if (!cb) {
			if (typeof body == "function") {
				cb = body;
				body = null;
			} else if (typeof query == "function") {
				cb = query;
				query = null;
			} else {
				cb = function(err) {
					if (err) console.error(err);
				};
			}
		}
		// consume parameters from query object
		url = urlParams(url, query);
		url = absolute(document.location, url);
		if (/^(HEAD|GET|COPY)$/i.test(method)) {
			query = query || body || {};
		} else {
			// give priority to body
			if (!body && query) {
				body = query;
				query = null;
			}
			if (body) body = JSON.stringify(body);
		}
		url = urlQuery(url, query);
		var xhr = new XMLHttpRequest();
		xhr.open(method, url, true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
		xhr.onreadystatechange = function (e) {
			if (xhr.readyState == 4) {
				var code = xhr.status;
				var response = tryJSON(xhr.responseText);
				if (code >= 200 && code < 400) {
					cb(null, response);
				} else {
					var err = new Error(response);
					err.code = code;
					cb(err);
				}
			}
		};
		xhr.send(body);
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
	var date = new Date(txt);
	var time = date.getTime();
	if (isNaN(time)) return;
	else return date;
}

function $(str) {
	return document.querySelector(str);
}


})();
