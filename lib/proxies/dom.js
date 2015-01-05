var URL = require('url');

module.exports = DomProxy;

function DomProxy(raja, dom) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, dom);
	this.raja = raja;
	this.dom = dom;
	this.remote = raja.proxies.remote();
	this.local = raja.proxies.local();

	// hook into express-dom
	var self = this;
	if (dom.Handler._patched) {
		throw new Error("DomProxy initialized twice");
	}
	dom.Handler._patched = true;

	dom.author(function(h) {
		h.page.run(function(ioUri, done) {
			if (ioUri) {
				var meta = document.createElement('meta');
				meta.id = 'raja-io';
				meta.content = ioUri;
				var tn = document.createTextNode("\n");
				document.head.insertBefore(tn, document.head.firstChild);
				document.head.insertBefore(meta, tn);
			}
			done();
		}, raja.opts.io.uri);
	});

	dom.Handler.prototype.getView = function(req, cb) {
		getView.call(this, self, req, function(err) {
			this.authorUrl = "author:" + this.viewUrl;
			cb(err);
		}.bind(this));
	};
	var acquire = dom.Handler.prototype.acquire;
	dom.Handler.prototype.acquire = function(cb) {
		var h = this;
		acquire.call(h, function(err) {
			if (h.page && !h.page.rajaHandlers) {
				h.page.rajaHandlers = true;
				h.page.on('error', raja.error.bind(raja));
			}
			cb(err);
		});
	};


	var getAuthored = dom.Handler.prototype.getAuthored;
	dom.Handler.prototype.getAuthored = function(req, res, cb) {
		var h = this;
		var authorUrl = this.authorUrl;
		raja.store.get(authorUrl, function(err, resource) {
			if (err) raja.error(err); // fall through
			var next = getAuthored.bind(this, req, res, function(err) {
				if (err) return cb(err); // stop - should invalidate ?
				else cb(); // fall through
				raja.store.set(authorUrl, {
					mime: "text/html",
					data: this.authorHtml,
					resources: [this.viewUrl]
				}, function(err) {
					if (err) return raja.error(err);
					raja.send({
						method: "put",
						url: authorUrl
					});
				});
			}.bind(this));
			if (resource) {
				if (resource.valid) {
					this.authorHtml = resource.data;
					cb();
				} else {
					next();
				}
			} else {
				next();
			}
		}.bind(this));
	};

	var getUsed = dom.Handler.prototype.getUsed;
	dom.Handler.prototype.getUsed = function(req, res, cb) {
		if (process.env.AUTHOR) {
			console.info("AUTHOR mode, skipping user scripts");
			this.html = this.authorHtml;
			cb();
			return;
		}
		var h = this;
		var url = h.url;
		raja.store.get(url, function(err, resource) {
			if (err) raja.error(err); // fall through
			var next = function() {
				this.users.unshift(tracker);
				getUsed.call(this, req, res, function(err) {
					this.users.shift();
					if (err) return cb(err); // stop - should invalidate ?
					else cb(); // fall through
					raja.store.set(url, {
						mime: "text/html",
						data: this.html,
						resources: this.resources
					}, function(err) {
						if (err) return raja.error(err);
						raja.send({
							method: "put",
							url: url
						});
					});
				}.bind(this));
			}.bind(this);
			if (resource) {
				if (resource.valid) {
					this.html = resource.data;
					cb();
				} else {
					next();
				}
			} else {
				next();
			}
		}.bind(this));
	};
}

function tracker(h) {
	if (!h.resources) {
		h.resources = {};
		h.resources[h.authorUrl] = true;
	};
	h.page.on('response', function(res) {
		if (res.uri == h.url) return;
		if (res.status >= 200 && res.status < 400) {
			if (res.mime != "application/octet-stream") {
				h.resources[res.uri] = true;
			}
		}
	});
}

function getView(proxy, req, cb) {
	var h = this;
	var settings = req.app.settings;
	if (/https?:/.test(h.viewUrl)) {
		proxy.remote.get(h.viewUrl, function(err, body) {
			if (body) h.viewHtml = body;
			else err = new Error("Empty initial html in " + h.viewUrl);
			cb(err);
		});
	} else {
		var expressView = new (settings.view)(h.viewUrl, {
			defaultEngine: 'html',
			root: settings.views,
			engines: {".html": function() {}}
		});
		if (!expressView.path) {
			var root = expressView.root;
			var dirs = Array.isArray(root) && root.length > 1
			?	'directories "' + root.slice(0, -1).join('", "') + '" or "' + root[root.length - 1] + '"'
			: 'directory "' + root + '"';
			var err = new Error('Failed to lookup view "' + h.viewUrl + '" in views ' + dirs);
			err.view = expressView;
			return cb(err);
		}
		h.viewUrl = expressView.path;
		proxy.local.get(h.viewUrl, function(err, body) {
			if (body) h.viewHtml = body;
			else err = new Error("Empty initial html in " + expressView.path);
			cb(err);
		});
	}
}

