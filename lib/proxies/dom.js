var URL = require('url');
var queue = require('queue-async');
var CacheOnDemand = require('cache-on-demand');

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
		h.page.run(function(ioclientUri, done) {
			if (ioclientUri) {
				var meta = document.createElement('meta');
				meta.id = 'raja-io';
				meta.content = ioclientUri;
				var tn = document.createTextNode("\n");
				document.head.insertBefore(meta, document.head.firstChild);
				document.head.insertBefore(tn, meta);
			}
			done();
		}, raja.opts.client);
	});
	var listener = function(msg) {
		var url = msg.url;
		var parent = msg.parents.slice(-1).pop();
		var h = this;
		if (!parent && url == h.viewUrl) {
			if (msg.mtime > h.mtime)	{
				h.mtime = msg.mtime;
				delete h.validViewHtml;
			}
			return;
		}
		var inst = parent && h.pages[parent];
		if (inst && msg.mtime > inst.mtime) {
			// msg.url is the url of the file on disk
			var firstParent = msg.parents.slice().shift();
			if (firstParent == inst.authorUrl) {
				delete inst.validAuthorHtml;
			}
			// trigger busy update
 			inst.lastmtime = msg.mtime;
			// check inst.resources - inst might just be a cache hit instance
			// inst.page might not exist, though, but reloads is good in case
			// the webkit cache kicks in on next load
			if (inst.resources && inst.resources[firstParent] == "application/javascript") {
				// slow page reload - note that client cache might prevent
				// resource from being updated properly
				inst.live = false;
				if (!inst.reloads) inst.reloads = {};
				inst.reloads[firstParent] = msg.mtime;
			}
		}
	};
	dom.Handler.prototype.init = function() {
		this.listener = listener.bind(this);
		raja.on('message', this.listener);
	};

	dom.Handler.prototype.loadLocal = this.local.get.bind(this.local);
	dom.Handler.prototype.loadRemote = this.remote.get.bind(this.remote);

	var build = dom.Handler.prototype.build;
	dom.Handler.prototype.build = CacheOnDemand(function(inst, req, res, cb) {
		res.set('X-Raja', raja.opts.namespace);
		build.call(this, inst, req, res, cb);
	}, function(inst) {
		return inst.url;
	});

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
									h.mtime = resource.mtime;
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
				inst.page.on('request', function(req) {
					if (!inst.resources) return;
					if (inst.existings && inst.existings[req.uri]) {
						// copy back because some of them won't have response because of the cache
						inst.resources[req.uri] = inst.existings[req.uri];
					}
					if (inst.reloads && inst.reloads[req.uri]) {
						req.headers['Cache-Control'] = 'no-cache';
					}
				});
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
							var mime = res.mime;
							var oldMime = inst.resources[res.uri];
							if (!oldMime) {
								if (!mime) mime = true;
							} else if (!mime) mime = oldMime;
							inst.resources[res.uri] = mime;
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
			}, cb);
		});
	};

	// update raja cache when html is generated
	var _getUsed = dom.Handler.prototype.getUsed;
	dom.Handler.prototype.getUsed = function(inst, req, res, cb) {
		var h = this;
		var next = function(err) {
			if (err) return cb(err);
			if (inst.existings) delete inst.existings;
			if (inst.reloads) delete inst.reloads;
			if (!inst.lastmtime || inst.lastmtime <= inst.mtime) {
				inst.validHtml = inst.html;
				inst.mtime = Date.now();
				raja.store.set(inst.url, {
					mtime: inst.mtime,
					mime: "text/html",
					data: inst.html,
					resources: Object.keys(inst.resources)
				}, cb);
			} else {
				cb();
			}
		};
		// set mtime before getting html or something can happen in between

		if (inst.page && inst.live && !inst.validHtml) {
			inst.page.html(function(err, html) {
				if (html) inst.html = html;
				next(err);
			});
		} else {
			if (inst.resources) inst.existings = inst.resources;
			inst.resources = {};
			inst.resources[inst.authorUrl] = true;
			if (!h.useBusy) {
				h.useBusy = true;
				h.use(function(inst) {
					inst.page.on('busy', function() {
						if (inst.lastmtime && inst.lastmtime > inst.mtime) {
							delete inst.lastmtime;
							delete inst.validHtml;
							// update resources to make sure instances loaded on server receive messages
							raja.store.set(inst.url, {resources: Object.keys(inst.resources)}, raja.error);
						}
					});
				});
			}
			_getUsed.call(h, inst, req, res, next);
		}
	};

	dom.logInstance = function(inst) {
		var obj = {};
		for (var key in inst) {
			if (/data|authorHtml|viewHtml|html|validHtml|validAuthorHtml|validViewHtml/.test(key)) obj[key] = inst[key] && inst[key].toString().length;
			else if (key == "page") obj.page = true;
			else obj[key] = inst[key];
		}
		console.log(obj);
	};
}

