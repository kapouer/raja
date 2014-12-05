var orm = require('orm');

// TODO when a clear API emerges, hide orm behind it
// TODO use a front in-memory cache for most used items - but
// keep the amount of used memory configurable

module.exports = function(raja, uri, cb) {
	var store = new Store();
	orm.connect(uri, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store() {

}
Store.prototype.init = function(db, cb) {
	var Resource = this.Resource = db.define('Resource', {
		url : { type: 'text', unique: true, index: true },
		mtime : { type: 'date', time: true, index: true },
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 }
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
		reverse : "parents"
	});
	Resource.sync(function(err) {
		cb(err, this);
	}.bind(this));
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

Store.prototype.invalidateParents = function(url, cb) {
	this.Resource.one({url: url}).getParents().each(function(res) {
		res.valid = false;
	}).save(cb);
};

Store.prototype.set = function(url, obj, cb) {
	this.Resource.one({url: url}, function(err, res) {
		if (err) return cb(err);
		if (!res) res = new (this.Resource)();
		res.url = url;
		res.children = obj.links || [];
		res.data = obj.data;
		res.valid = true;
		res.save(cb);
	}.bind(this));
};

