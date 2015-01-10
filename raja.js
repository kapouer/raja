/*
 * raja browser client
 */
(function() {

window.raja = new Raja();

script('/socket.io/socket.io.js', function(err) {
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

Raja.prototype.delay = function(url, listener) {
	this.delays.push([url, listener]);
	return this;
};

Raja.prototype.ready = function() {
	this.url = this.absolute('.');
	// work around webkit bug https://bugs.webkit.org/show_bug.cgi?id=4363
	var lastMod = Date.parse(document.lastModified);
	var now = new Date();
	var diff = (new Date(now.toLocaleString())).getTimezoneOffset() - now.getTimezoneOffset();
	if (!diff) diff = now.getTimezoneOffset() * 60000;
	else diff = 0;
	this.mtime = lastMod - diff;

	if (isNaN(this.mtime)) this.mtime = Date.now();
	this.resources = {};
	var links = document.head.querySelectorAll('link[rel="resource"]');
	for (var i=0; i < links.length; i++) {
		var link = links.item(i);
		this.resources[link.href] = {url: link.href, mtime: this.mtime};
	}
	var list = this.delays;
	delete this.delays;
	for (var i=0; i < list.length; i++) {
		this.on(list[i][0], list[i][1]);
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

Raja.prototype.on = function(url, listener) {
	if (!this.resources) {
		return this.delay(url, listener);
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
	url = this.absolute(url);
	var murl = url.split('?').shift();
	this._on(murl, plistener);
	var resources = this.resources;
	var resource = resources[murl];
	if (!resource) resource = resources[murl] = {url: murl};
	if (resource.error) return;

	(function(next) {
		if (resource.data !== undefined) {
			// resource has been loaded once
			// this is wrong when murl != url
			listener(resource.data, {method:"get", url: url, mtime: resource.mtime});
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
		Raja.xhr(url, function(err, txt, mtime) {
			var obj = tryJSON(txt);
			if (err) {
				resource.error = err;
				return next(err);
			}
			self.link(resource.url);
			resource.mtime = mtime;
			resource.data = obj;
			var queue = resource.queue;
			for (var i=0; i < queue.length; i++) {
				try {
					queue[i](obj, {method:"get", url: url, mtime: mtime});
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
		mtime: this.mtime
	});

	this.io.on('message', function(msg) {
		if (!msg.url) return;
		var data = msg.data;
		if (data) delete msg.data;
		var resource = self.resources[msg.url];
		if (resource) {
			if (!resource.mtime || msg.mtime > resource.mtime) resource.mtime = msg.mtime;
		}
		if (msg.mtime > self.mtime) {
			self.mtime = msg.mtime;
			if (msg.url != self.url && !resource) {
				// a static file has changed
			}
		}
		self.emit(msg.url, data, msg);
	});
};

Raja.prototype.absolute = function(url) {
	if (/^https?/i.test(url)) return url;
	var path = document.location.pathname;
	if (url.indexOf('..') == 0) {
		path = path.split('/');
		path.pop();
		url = path.join('/') + url.substring(2);
	} else if (url.indexOf('.') == 0) {
		url = path + url.substring(1);
	}
	// regular interpretation of url
	if (!this._a) this._a = document.createElement('a');
	this._a.href = url;
	return this._a.href;
};

Raja.xhr = function(url, cb) {
	var req = new XMLHttpRequest();
	req.open('GET', url, true);
	req.onreadystatechange = function (e) {
		if (req.readyState == 4) {
			if (req.status >= 200 && req.status < 300) {
				cb(null, req.responseText, tryDate(req.getResponseHeader("Last-Modified")));
			} else {
				cb(req.status, req.responseText);
			}
		}
	};
	req.send(null);
	return req;
};

function script(url, cb) {
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

function tryJSON(txt) {
	var obj;
	try {
		obj = JSON.parse(txt);
	} catch(e) {
		console.error(e.toString());
		return txt;
	}
	return obj;
}

function tryDate(txt) {
	if (!txt) return;
	var date = new Date(txt);
	var time = date.getTime();
	if (isNaN(time)) return;
	else return time;
}

function $(str) {
	return document.querySelector(str);
}


})();
