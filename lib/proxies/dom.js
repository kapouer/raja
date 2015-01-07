var URL = require('url');
var queue = require('queue-async');

module.exports = DomProxy;

function DomProxy(raja, dom) {
	if (!(this instanceof DomProxy)) return new DomProxy(raja, dom);
	this.raja = raja;
	this.dom = dom;
	this.remote = raja.proxies.remote();
	this.local = raja.proxies.local();

	var ioreg;

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
	var listener = function(msg) {
		var url = msg.url;
		if (!url) return;

		var h = this;
		if (url == h.viewUrl) {
			if (msg.mtime > h.viewmtime)	{
				console.log("invalidate viewHtml")
				delete h.validViewHtml;
			}
		} else {
			var isAuthorUrl = /author:/.test(url);
			if (isAuthorUrl) url = url.substring("author:".length);
			var inst = h.pages[url];
			if (inst && msg.mtime > inst.mtime) {
				if (isAuthorUrl) {
					delete inst.validAuthorHtml;
				} else {
					delete inst.validHtml;
				}
			}
		}
	};
	dom.Handler.prototype.init = function() {
		this.listener = listener.bind(this);
		raja.io.on('message', this.listener);
	};

	dom.Handler.prototype.loadLocal = this.local.get.bind(this.local);
	dom.Handler.prototype.loadRemote = this.remote.get.bind(this.remote);

	var _instance = dom.Handler.prototype.instance;
	dom.Handler.prototype.instance = function(url, cb) {
		var h = this;
		_instance.call(this, url, function(err, inst) {
			if (err) return cb(err);
			if (!inst.authorUrl) inst.authorUrl = "author:" + h.viewUrl;
			if (!inst.mtime) inst.mtime = Date.now();
			if (inst.validHtml) {
				inst.html = inst.validHtml;
				return cb(null, inst);
			} else raja.store.get(url, function(err, resource) {
				if (err) return cb(err);
				if (resource && resource.valid) {
					inst.html = inst.validHtml = resource.data;
					inst.mtime = resource.mtime;
					cb(null, inst);
				} else {
					delete inst.html;
					if (inst.validAuthorHtml) {
						inst.authorHtml = inst.validAuthorHtml;
						cb(null, inst);
					} else raja.store.get(inst.authorUrl, function(err, resource) {
						if (err) return cb(err);
						if (resource && resource.valid) {
							inst.authorHtml = inst.validAuthorHtml = resource.data;
							inst.mtime = resource.mtime;
							cb(null, inst);
						} else {
							delete inst.authorHtml;
							if (h.validViewHtml) {
								h.viewHtml = h.validViewHtml;
								cb(null, inst);
							} else raja.store.get(h.viewUrl, function(err, resource) {
								if (err) return cb(err);
								if (resource && resource.valid) {
									h.viewHtml = h.validViewHtml = resource.data;
									h.viewmtime = resource.mtime;
								} else {
									delete h.viewHtml;
								}
								cb(null, inst);
							});
						}
					})
				}
			});
		});
	};

	// install error handler right after page instantiation
	var _acquire = dom.Handler.prototype.acquire;
	dom.Handler.prototype.acquire = function(inst, cb) {
		var h = this;
		_acquire.call(h, inst, function(err) {
			if (inst.page && !inst.page.rajaHandlers) {
				inst.page.rajaHandlers = true;
				inst.page.on('unload', function() {}); // keep it running !
				inst.page.on('error', raja.error.bind(raja));
				inst.page.on('response', function(res) {
					if (res.uri == inst.url) return;
					if (res.status >= 200 && res.status < 400) {
						if (!ioreg) {
							var iopath = raja.io && raja.io.socket && raja.io.socket.io.opts.path;
							if (iopath) ioreg = new RegExp("^" + iopath);
						}
						if (res.mime == "application/octet-stream" || res.mime != "application/javascript" && ioreg && ioreg.test(URL.parse(res.uri).pathname)) {
							inst.weight = 4; // prioritize "live" pages
							inst.live = true;
						} else {
							inst.resources[res.uri] = true;
						}
					}
				});
			}
			cb(err);
		});
	};

	// update raja cache when authorHtml is generated
	var _getAuthored = dom.Handler.prototype.getAuthored;
	dom.Handler.prototype.getAuthored = function(inst, req, res, cb) {
		var h = this;
		_getAuthored.call(h, inst, req, res, function(err) {
			inst.validAuthorHtml = inst.authorHtml;
			inst.page.rajaHandlers = false; // have been removed by _getAuthored
			inst.mtime = Date.now();
			raja.store.set(inst.authorUrl, {
				mtime: inst.mtime,
				mime: "text/html",
				data: inst.authorHtml,
				resources: [h.viewUrl]
			}, function(err) {
				if (err) return cb(err);
				else cb();
				raja.send({
					mtime: inst.mtime,
					method: "put",
					url: inst.authorUrl
				});
			});
		});
	};

	// update raja cache when html is generated
	var _getUsed = dom.Handler.prototype.getUsed;
	dom.Handler.prototype.getUsed = function(inst, req, res, cb) {
		var h = this;
		var next = function(err) {
			if (err) return cb(err);
			inst.validHtml = inst.html;
			inst.mtime = Date.now();
			raja.store.set(inst.url, {
				mtime: inst.mtime,
				mime: "text/html",
				data: inst.html,
				resources: inst.resources
			}, function(err) {
				if (err) return cb(err);
				else cb();
				raja.send({
					mtime: inst.mtime,
					method: "put",
					url: inst.url
				});
			});
		};

		// fast path update
		if (!inst.validHtml && inst.page && inst.live) {
			inst.page.wait('idle').html(function(err, html) {
				if (err) return next(err);
				inst.html = html;
				next();
			});
		} else {
			inst.resources = {};
			inst.resources[inst.authorUrl] = true;
			_getUsed.call(h, inst, req, res, next);
		}
	};
	dom.Handler.prototype.dump = function(inst) {
		var obj = {};
		for (var key in inst) {
			if (/data|authorHtml|viewHtml|html|validHtml|validAuthorHtml|validViewHtml/.test(key)) obj[key] = inst[key] && inst[key].toString().length;
			else if (key == "page") obj.page = true;
			else obj[key] = inst[key];
		}
		console.log(obj);
	};
}

