var BufferResponse = require('express-buffer-response');

module.exports = ExpressProxy;

function ExpressProxy(raja, app, opts) {
	if (!(this instanceof ExpressProxy)) return new ExpressProxy(raja, app, opts);
	this.raja = raja;
	this.opts = opts;
	app.use(this.middleware);
}

ExpressProxy.prototype.middleware = function(req, res, next) {
	var url = req.url;
	var raja = this.raja;
	if (req.method == "GET") this.raja.store.get(url, function(err, resource) {
		if (err) raja.error(err); // fall through
		if (resource && resource.valid) {
			res.send(resource.data);
		} else {
			BufferResponse(res, function(err, bufl) {
				if (err) return console.error(err); // or just return if already logged
				this.finished(url, res.statusCode, bufl);
			}.bind(this));
			next();
		}
	});
	else {
		raja.store.invalidate(url, function(err) {
			if (err) return raja.error(err);
			raja.send({
				method: req.method.toLowerCase(),
				url: url,
				mtime: Date.now()
			});
		});
		next();
	}
};

ExpressProxy.prototype.finished = function(url, status, bufl) {
	this.raja.store.set(url, {
		url: url,
		code: code,
		data: bufl
	}, this.raja.error);
};

