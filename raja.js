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

Raja.prototype.updateLink = function(resource, mtime) {
	var link = $('head > link[rel="resource"][href="'+resource.url+'"]');
	if (!link) {
		link = document.createElement('link');
		link.rel = "resource";
		link.href = resource.url;
		var tn = document.createTextNode("\n");
		document.head.insertBefore(tn, document.head.firstChild);
		document.head.insertBefore(link, tn);
	}
	if (mtime != null) {
		resource.mtime = mtime;
		link.setAttribute("last-modified", mtime.getTime());
	} else {
		console.warn("empty mtime", resource, mtime);
	}
};

Raja.prototype.delay = function(url, listener) {
	this.delays.push([url, listener]);
	return this;
};

Raja.prototype.ready = function() {
	this.resources = {};
	var links = document.head.querySelectorAll('link[rel="resource"]');
	for (var i=0; i < links.length; i++) {
		var link = links.item(i);
		this.resources[link.href] = {
			mtime: link.getAttribute('last-modified'),
			url: link.href
		};
	}
	var list = this.delays;
	delete this.delays;
	for (var i=0; i < list.length; i++) {
		this.on(list[i][0], list[i][1]);
	}
};

Raja.prototype.emit = function(what) {
	var args = Array.prototype.slice.call(arguments, 0);
	this._emit.apply(this, args);
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
	(function(next) {
		if (resource) {
			if (resource.data !== undefined) {
				listener(resource.data, {method:"get", url: url, mtime: resource.mtime});
			}
			return next();
		}
		resource = resources[murl] = {url: murl};
		xhr(url, function(err, txt, mtime) {
			var obj = tryJSON(txt);
			if (err) return next(err);
			resource.data = obj;
			listener(obj, {method:"get", url: url, mtime: mtime});
			self.updateLink(resource, mtime);
			next();
		});
	})(function(err) {
		if (err) self.emit('error', err);
		if (!resource.room) {
			resource.room = murl;
			self.io.emit('join', {room: murl, mtime: resource.mtime});
		}
	});
	return this;
};

Raja.prototype.setio = function() {
	this.io = io(this.base);
	var self = this;
	this.io.on('reconnect_failed', function(err) {
		if (err) self.emit('error', err);
	});
	this.io.on('message', function(msg) {
		var data = msg.data;
		if (data) delete msg.data;
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

function xhr(url, cb) {
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
}

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
	if (isNaN(date.getTime())) return;
	else return date;
}

function $(str) {
	return document.querySelector(str);
}


})();
