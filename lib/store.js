var orm = require('orm');
var q = require('queue-async');

// TODO when a clear API emerges, hide orm behind it
// TODO use a front in-memory cache for most used items - but
// keep the amount of used memory configurable

module.exports = function(raja, uri, cb) {
	var store = new Store(raja);
	orm.connect(uri, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store(raja) {
	this.raja = raja;
}
Store.prototype.init = function(db, cb) {
	var Resource = this.Resource = db.define('Resource', {
		url : { type: 'text', index: true },
		mtime : { type: 'date', time: true, index: true },
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 },
		mime: { type: 'text' }
	}, {
		table: "raja_cached_resources",
		cache: false,
		hooks: {
			beforeSave: function(next) {
				this.mtime = new Date();
				next();
			}
		},
	});
	Resource.hasMany("children", Resource, {}, {
		reverse : "parents",
		key: true
	});
	var store = this;
	Resource.drop(function(err) {
		if (err) console.error(err);
		Resource.sync(function(err) {
			cb(err, store);
		});
	});
};

Store.prototype.get = function(url, cb) {
	this.Resource.one({url: url}, cb);
};

Store.prototype.has = function(url, cb) {
	this.Resource.count({url: url}, function(err, count) {
		cb(err, !!count);
	});
};

Store.prototype.del = function(url, cb) {
	this.Resource.find({url: url}).remove(cb);
};

Store.prototype.invalidate = function(url, cb) {
	// what happens if it does not find any resource ?
	this.Resource.find({url: url}).each(function(res) {
		res.valid = false;
	}).save(cb);
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var url = msg.room || msg.url;
	this.Resource.find({url: url}, function(err, rows) {
		var queue = q(1);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + url));
		else if (rows.length == 0) return cb();
		var res = rows[0];
		res.getParents().each(function(par) {
			par.valid = false;
			var cmsg = raja.shallow(msg);
			if (cmsg.room) cmsg.url = cmsg.room;
			cmsg.room = par.url;
			raja.send(cmsg);
		}).save(cb);
	});
};

Store.prototype.set = function(url, obj, cb) {
	if (!cb && typeof obj == "function") {
		cb = obj;
		obj = null;
	}
	if (!obj) obj = {};
	this.Resource.one({url: url}, function(err, res) {
		if (err) return cb(err);
		if (!res) res = new (this.Resource)();
		if (obj.url !== undefined) res.url = obj.url;
		else if (!res.url) res.url = url;
		if (obj.data !== undefined) res.data = obj.data;
		res.valid = obj.valid !== undefined ? obj.valid : true;
		if (obj.code !== undefined) res.code = obj.code;
		if (obj.mime !== undefined) res.mime = obj.mime;
		res.save(function(err) {
			if (err) return cb(err, res);
			if (obj.resources !== undefined) saveResources.call(this, res, obj.resources, cb);
			else cb(null, res);
		}.bind(this));
	}.bind(this));
};

function saveResources(inst, resources, cb) {
	var self = this;
	if (Array.isArray(resources)) {
		var hash = {};
		for (var i=0; i < resources.length; i++) {
			hash[resources[i]] = true;
		}
		resources = hash;
	}
	inst.getChildren(function(err, children) {
		if (err) return cb(err, inst);
//		var toRemove = [];
		var toNotSave = {};
		for (var i=0; i < children.length; i++) {
			var child = children[i];
			if (resources[child.url]) {
				// no need to add it in any way, but should we do something about status ?
				// if child.status is not between 200 and 300 set it to 200
				// ...
				// then mark it as dealt with
				toNotSave[child.url] = true;
			} else {
//				toRemove.push(child);
			}
		}
		var saveQueue = q(1);
		for (var url in resources) {
			// add this url to resources
			if (!toNotSave[url]) saveQueue.defer(self.set.bind(self), url);
		}
		saveQueue.awaitAll(function(err, toAdd) {
			if (err || toAdd.length == 0) return cb(err, inst);
			inst.addChildren(toAdd, function(err) {
				cb(err, inst);
			});
		});
	});
}

