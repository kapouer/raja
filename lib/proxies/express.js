var BufferResponse = require('express-buffer-response');
var queue = require('async-queue');

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
			if (resource && resource.valid) {
				res.set('Last-Modified', resource.mtime.toUTCString());
				res.send(resource.data);
			} else {
				BufferResponse(res, function(err, bufl) {
					if (err) return console.error(err); // or just return if already logged
					this.finished(url, res.statusCode, bufl.slice());
				}.bind(this));
				res.set('Last-Modified', (new Date()).toUTCString());
				next();
			}
		}.bind(this));
	} else {
		BufferResponse(res, function(err, buf) {
			if (err) return raja.error(err);
			if (res.statusCode < 200 || res.statusCode >= 400) return;
			// undefined if url is already the url of a collection
			var collectionUrl = resourcePath(req.route.path, url, req.params);
			var msg = {
				method: req.method.toLowerCase(),
				mtime: Date.now()
			};
			if (req.is("json") && req.body) msg.data = req.body;
			if (res.get('Location')) url = res.get('Location');

			invalidateAndSend(raja, url, msg);
			if (collectionUrl) invalidateAndSend(raja, collectionUrl, msg);
		});
		next();
	}
};

ExpressProxy.prototype.finished = function(url, code, buf) {
	this.raja.store.set(url, {
		code: code,
		data: buf
	}, this.raja.error);
};

function resourcePath(routePath, url, params) {
	var find = /^:.+\?$/.exec(routePath.split('/').pop());
	if (find != null && params[find[1]] !== undefined) {
		url = url.split('/');
		url.pop();
		url = url.join('/');
		return url;
	} else {
		return;
	}
}

function invalidateAndSend(raja, url, msg) {
	msg.url = url;
	raja.store.invalidate(url, function(err) {
		if (err) return raja.error(err);
		raja.send(msg);
	});
}
