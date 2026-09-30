/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search'], (search) => {

    const saveRecord = (context) => {
        try {
            const rec = context.currentRecord;

            const po = (rec.getValue({
                fieldId: 'otherrefnum'
            }) || '').trim();

            if (!po) {
                return true;
            }

            const filters = [
                ['mainline', 'is', 'T'],
                'AND',
                ['otherrefnum', 'equalto', po]
            ];

            // Exclude current Sales Order while editing
            if (rec.id) {
                filters.push(
                    'AND',
                    ['internalid', 'noneof', rec.id]
                );
            }

            const salesOrderSearch = search.create({
                type: search.Type.SALES_ORDER,
                filters: filters,
                columns: [
                    search.createColumn({
                        name: 'internalid'
                    }),
                    search.createColumn({
                        name: 'tranid'
                    }),
                    search.createColumn({
                        name: 'otherrefnum'
                    })
                ]
            });

            const results = salesOrderSearch.run().getRange({
                start: 0,
                end: 1
            });

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

            // Allow save if unexpected script error occurs
            return true;
        }
    };

    return {
        saveRecord: saveRecord
    };
});