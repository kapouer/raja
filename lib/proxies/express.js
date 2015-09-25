var BufferResponse = require('express-buffer-response');
var onHeaders = require('on-headers');
var pathRegexp = require('path-to-regexp');
var URL = require('url');
//var CacheDebounce = require('cache-debounce');
var debug = require('debug')('raja:express');

module.exports = ExpressProxy;

function ExpressProxy(raja, opts) {
	if (!(this instanceof ExpressProxy)) return new ExpressProxy(raja, opts);
	this.raja = raja;
	this.opts = opts || {};
	this.middleware = this.middleware.bind(this);
}

//var GetMw = CacheDebounce(function(url, baseUrl, req, res, next, cb) {
var GetMw = function(url, baseUrl, req, res, next, cb) {
	var raja = this.raja;
	res.set('X-Raja', raja.opts.namespace);
	raja.retrieve(url, res, function(err, resource) {
		if (err) raja.error(err); // fall through
		if (resource && resource.valid) {
			debug('found valid', resource.key, resource.headers);
			for (var name in resource.headers) {
				if (name in {'Content-Type':1, 'ETag':1, 'Vary':1, 'Content-Encoding':1, 'X-Grant': 1, 'X-Raja':1}) {
					res.set(name, resource.headers[name]);
				}
			}
			var ETag = resource.headers.ETag;
			if (ETag && req.get('If-None-Match') == ETag) {
				res.sendStatus(304);
			} else {
				if (resource.headers['X-Grant']) {
					res.set('Cache-Control', 'max-age=0,must-revalidate,private,no-cache');
					res.set('Pragma', 'no-cache');
				}
				if (resource.mtime) {
					res.set('Last-Modified', resource.mtime.toUTCString());
				}
				res.send(resource.data);
			}
			cb();
		} else {
			if (!resource) {
				debug('no resource found', url);
				resource = raja.create({url: url, builder: 'express'}, res);
			} else {
				debug('found invalid resource', resource.key);
			}
			req.resource = resource;
			var curETag;
			onHeaders(res, function() {
				var etag = res.get('ETag');
				if (etag && !res.statusCode == 304) {
					curETag = etag;
					res.set('ETag', '');
				}
				var lastMod = res.get('Last-Modified');
				if (lastMod) {
					lastMod = new Date(lastMod);
					if (isNaN(lastMod.getTime())) lastMod = null;
				}
				if (!lastMod) {
					lastMod = new Date();
				}
				if (resource.headers['X-Grant']) {
					res.set('Cache-Control', 'max-age=0,must-revalidate,private,no-cache');
					res.set('Pragma', 'no-cache');
				}
				res.set('Last-Modified', lastMod.toUTCString());
				resource.mtime = lastMod;
			});

			BufferResponse(res, function(err, bufl) {
				delete req.resource;
				if (err) return cb(err);
				// not sure we must ignore codes above 300 but what to do with them ?
				if (res.statusCode >= 200 && res.statusCode < 300) {
					resource.headers = raja.headers(res);
					if (curETag) resource.headers.ETag = curETag;
					resource.code = res.statusCode;
					resource.data = bufl.slice();
					resource.valid = true;
					debug('cache response', res.statusCode, url, resource.headers);
					if (url != baseUrl && isResJson(res)) {
						debug("url with query depends on baseUrl", url, baseUrl);
						// assume same type
						var depHeaders = {};
						for (var name in resource.headers) {
							if (name in {'Vary':1, 'Content-Type':1, 'X-Raja':1}) {
								depHeaders[name] = resource.headers[name];
							}
						}
						resource.depend({url: baseUrl, headers: depHeaders, builder: 'express'});
					}
					resource.save();
				} else {
					debug("response not cached because of statusCode", url, res.statusCode);
				}
				cb();
			}.bind(this));
			next();
		}
	}.bind(this));
};
//}, function(url) {
//	return url;
//});

ExpressProxy.prototype.middleware = function(req, res, next) {
	var raja = this.raja;
	var method = req.method.toLowerCase();
	var baseUrl = req.protocol + "://" + req.get('Host');
	var url = baseUrl + req.url;
	baseUrl += req.path;

	if (this.opts.disable) {
		req.resource = raja.create({url: url, builder: 'express'}, res);
		return next();
	}

	if (method == "get") {
		GetMw.call(this, url, baseUrl, req, res, next, function(err) {
			if (err) console.error(err);
		});
	} else if (method == "purge") {
		res.set('X-Raja', raja.opts.namespace);
		raja.retrieve(url, res, function(err, resource) {
			if (err) return next(err);
			if (!resource) return next(404);
			function finish(err) {
				if (err) console.error(err);
				invalidateAndSend(raja, {
					key: raja.reskey(url, req),
					method: method,
					mtime: new Date()
				});
				res.sendStatus(200);
			}
			if (resource.page && raja.opts.dom) raja.opts.dom.pool.release(resource.page, finish);
			else finish();
		});
	} else {
		// must be done before because req.params changes
		var coll = collectionInfo(req.route.path, url, req.params);
		BufferResponse(res, function(err, bufl) {
			if (err) return raja.error(err);
			if (res.statusCode < 200 || res.statusCode >= 400) return;
			var now = new Date(); // TODO inspect HTTP response headers like Date, Last-Modified
			// data is response buffer or request body, in that order
			var data = bufl;
			if (method != "delete" && isResJson(res) && bufl && bufl.length) {
				data = JSON.parse(bufl.toString());
			} else if (isReqJson(req) && req.body) {
				data = req.body;
			}

			var headers = raja.headers(res);
			headers['X-Raja'] = raja.opts.namespace;
			if (method == "put" && !(coll && coll.url == url)) {
				// send the message about the element if the url concerns an element
				// and the method is PUT.
				invalidateAndSend(raja, {
					url: url,
					method: method,
					mtime: now,
					data: data
				}, headers);
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
				}, headers);
			} else if (method == "post") {
				debug(url, "a POST to a non-collection route is not correct, invalidating anyway");
				invalidateAndSend(raja, {
					url: url,
					method: method,
					mtime: now,
					data: ensureArray(data)
				}, headers);
			}
		});
		next();
	}
};

function isResJson(res) {
	return res.req.is.call({headers: {
		'transfer-encoding': true,
		'content-length': 0,
		'content-type': res.get('Content-Type')
	}}, "json");
}

function isReqJson(req) {
	var type = req.get('Content-Type') || req.get('Accept') || '';
	return req.is('json') || type.indexOf('/json') > 0;
}

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

function invalidateAndSend(raja, msg, headers) {
	if (!msg.key) {
		msg.key = raja.reskey({url:msg.url, headers: headers});
		delete msg.url;
	}
	debug("invalidate and send", msg.key);
	raja.store.invalidate(msg.key, function(err) {
		if (err) return raja.error(err);
		raja.send(msg);
	});
}

