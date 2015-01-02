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

	dom.Handler.prototype.getView = function(req, cb) {
		this.authorUrl = "author:" + this.viewUrl;
		getView.call(this, self, req, cb);
	};
	var acquire = dom.Handler.prototype.acquire;
	dom.Handler.prototype.acquire = function(cb) {
		if (!this.page.rajaHandlers) {
			this.page.rajaHandlers = true;
			this.page.on('error', raja.error.bind(raja));
		}
		acquire.call(this, cb);
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
				raja.store.set(authorUrl, {data: this.authorHtml, links: [this.viewUrl]}, function(err) {
					if (err) return raja.error(err);
					raja.send({
						method: 'put',
						path: authorUrl
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
		var h = this;
		var url = h.url;
		raja.store.get(url, function(err, resource) {
			if (err) raja.error(err); // fall through
			var next = function() {
				var links = {};
				function populateLinks(response) {
					if (response.uri == url) return;
					if (response.status >= 200 && response.status < 400) {
						// ignore streaming data
						if (response.mime != "application/octet-stream") {
							links[response.uri] = true;
						}
					}
				}
				this.page.on('response', populateLinks);
				getUsed.call(this, req, res, function(err) {
					this.page.removeListener('response', populateLinks);
					if (err) return cb(err); // stop - should invalidate ?
					else cb(); // fall through
					links = Object.keys(links);
					links.unshift(this.authorUrl);
					raja.store.set(url, {data: this.html, links: links}, function(err) {
						if (err) return raja.error(err);
						raja.send({
							method: 'put',
							path: url
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
		proxy.local.get(expressView.path, function(err, body) {
			if (body) h.viewHtml = body;
			else err = new Error("Empty initial html in " + expressView.path);
			cb(err);
		});
	}
}

