var BufferResponse = require('express-buffer-response');
var queue = require('async-queue');
var pathRegexp = require('path-to-regexp');
var URL = require('url');

module.exports = ExpressProxy;

function ExpressProxy(raja, opts) {
	if (!(this instanceof ExpressProxy)) return new ExpressProxy(raja, opts);
	this.raja = raja;
	this.opts = opts || {};
	this.middleware = this.middleware.bind(this);
}

ExpressProxy.prototype.middleware = function(req, res, next) {
	if (this.opts.filter && this.opts.filter(req) == false) return next();
	var url = req.protocol + "://" + req.get('Host') + req.url;
	var raja = this.raja;
	if (req.method == "GET") {
		this.raja.store.get(url, function(err, resource) {
			if (err) raja.error(err); // fall through
			res.set('X-Raja', raja.opts.namespace);
			if (resource && resource.valid) {
				res.set('Last-Modified', resource.mtime.toUTCString());
				if (resource.mime) res.type(resource.mime);
				res.send(resource.data);
			} else {
				BufferResponse(res, function(err, bufl) {
					if (err) return console.error(err); // or just return if already logged
					this.finished(url, res.statusCode, res.get('Content-Type'), bufl.slice());
				}.bind(this));
				res.set('Last-Modified', (new Date()).toUTCString());
				next();
			}
		}.bind(this));
	} else {
		// must be done before because req.params changes
		var coll = collectionInfo(req.route.path, url, req.params);
		BufferResponse(res, function(err, bufl) {
			if (err) return raja.error(err);
			if (res.statusCode < 200 || res.statusCode >= 400) return;
			var method = req.method.toLowerCase();
			var now = Date.now(); // TODO inspect HTTP response headers like Date, Last-Modified
			// data is response buffer or request body, in that order
			var data;
			if (res.get('Content-Type') == "application/json" && bufl && bufl.length) {
				data = bufl;
			} else if (req.is("json") && req.body) {
				data = req.body;
			}
			var msg = { method: method, mtime: Date.now() };
			if (method == "put" && !(coll && coll.url == url)) {
				// send the message about the element if the url concerns an element
				// and the method is PUT.
				invalidateAndSend(raja, {
					url: url,
					method: method,
					mtime: now,
					data: data
				});
			}
			if (coll) {
				if (method == "post" && res.get('Location')) {
					// obtain coll.value from matching loc against req.route.path
					coll.value = lastParam(req.route.path, res.get('Location'), coll.name);
				}
				if (coll.value !== undefined) {
					// either promote a DELETE element method to a collection method,
					// or integrate coll.name into a PUT element method data
					if (!data) data = {};
					if (data[coll.name] === undefined) data[coll.name] = coll.value;
				}
				invalidateAndSend(raja, {
					url: coll.url,
					method: method,
					mtime: now,
					data: ensureArray(data)
				});
			}
		});
		next();
	}
};

ExpressProxy.prototype.finished = function(url, code, mime, buf) {
	this.raja.store.set(url, {
		code: code,
		data: buf,
		mime: mime
	}, this.raja.error);
};

function collectionInfo(routePath, url, params) {
	var find = /^:(.+)\?$/.exec(routePath.split('/').pop());
	if (find != null && params.hasOwnProperty(find[1])) {
		var name = find[1];
		var value = params[name];
		if (value !== undefined) {
			url = url.split('/');
			url.pop();
			url = url.join('/');
		}
		return {url: url, name: name, value: value};
	} else {
		return;
	}
}

function lastParam(routePath, url, param) {
	var keys = [];
	var regexp = pathRegexp(routePath, keys);
	var m = regexp.exec(URL.parse(url).pathname);
	if (!m) return;
	var val = m[m.length-1];
	var key = keys[keys.length-1];
	if (key.name != param) return;
	if (typeof val == 'string') {
		try {	val = decodeURIComponent(val); } catch (e) { val = undefined; }
	}
	return val;
}

function ensureArray(data) {
	if (!data || data.length == 0) {
		// empty
		data = [];
	} else if (Array.isArray(data)) {
		// all right, do nothing
	} else if (typeof data == "string") {
		// pure strings
		if (data[0] == '{') data = '[' + data + ']';
	} else if (typeof data.slice == "function") {
		// Buffers, bl-buffers
		if (data.slice(0, 1).toString() == '{') data = '[' + data.toString() + ']';
	} else if (typeof data == "object") {
		// pure objects
		data = [data];
	}
	return data;
}

function invalidateAndSend(raja, msg) {
	raja.store.invalidate(msg.url, function(err) {
		if (err) return raja.error(err);
		raja.send(msg);
	});
}

