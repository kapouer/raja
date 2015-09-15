var Model = require('objection').Model;

function Relation() {
	Model.apply(this, arguments);
}

module.exports = Model.extend(Relation);

Relation.tableName = 'raja_relations';

