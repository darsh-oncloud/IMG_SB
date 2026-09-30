/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search'], (search) => {

    const validateField = (context) => {

        try {

            const rec = context.currentRecord;
            const fieldId = context.fieldId;

            // Only validate PO/Check Number field
            if (fieldId !== 'otherrefnum') {
                return true;
            }

            const po = String(
                rec.getValue({
                    fieldId: 'otherrefnum'
                }) || ''
            ).trim();

            console.log('PO entered:', po);

            if (!po) {
                return true;
            }

            const filters = [
                ['mainline', 'is', 'T'],
                'AND',
                ['otherrefnum', 'equalto', po]
            ];

            // Exclude current SO when editing
            if (rec.id) {
                filters.push(
                    'AND',
                    ['internalid', 'noneof', rec.id]
                );
            }

            const duplicateSearch = search.create({
                type: search.Type.SALES_ORDER,
                filters: filters,
                columns: [
                    'internalid',
                    'tranid',
                    'otherrefnum'
                ]
            });

            const results = duplicateSearch.run().getRange({
                start: 0,
                end: 1
            });

            console.log('Duplicate results:', results.length);

            if (results.length > 0) {

                const soNumber = results[0].getValue({
                    name: 'tranid'
                });

                alert(
                    'Duplicate PO Number Found.\n\n' +
                    'PO # ' + po +
                    ' already exists on Sales Order ' + soNumber +
                    '.\n\nPlease enter a different PO number.'
                );

                return false;
            }

            return true;

        } catch (e) {

            console.error('Duplicate PO Validation Error', e);

            return true;
        }
    };

    return {
        validateField: validateField
    };
});