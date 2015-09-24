var Model = require('objection').Model;

function Relation() {
	Model.apply(this, arguments);
}

module.exports = Model.extend(Relation);

Relation.tableName = 'raja_relations';

Relation.jsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'integer' },
		parent_id: { type: 'integer' },
		child_id: { type: 'integer' },
		order: { type: 'integer' }
	},
	required: ['parent_id', 'child_id']
};
