/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search', 'N/log'], (search, log) => {
    const saveRecord = (context) => {
        log.debug('STEP 1', 'saveRecord started');
        const rec = context.currentRecord;
        log.debug('STEP 2 - Current Record', {
            id: rec.id || 'NEW RECORD',
            type: rec.type
        });
        const po = (rec.getValue({
            fieldId: 'otherrefnum'
        }) || '').trim();
        log.debug('STEP 3 - PO Number', {
            po: po
        });
        if (!po) {
            log.debug('STEP 4 - No PO', 'PO # is empty. Skipping duplicate check.');
            return true;
        }
        const filters = [
            ['mainline', 'is', 'T'],
            'AND',
            ['otherrefnum', 'equalto', po]
        ];
        log.debug('STEP 5 - Base Filters Created', filters);
        // Exclude current Sales Order while editing
        if (rec.id) {
            filters.push(
                'AND',
                ['internalid', 'noneof', rec.id]
            );
            log.debug('STEP 6 - Current SO Excluded', {
                currentSalesOrderId: rec.id
            });
        } else {
            log.debug('STEP 6 - New Sales Order', 'No current internal ID to exclude');
        }
        log.debug('STEP 7 - Final Search Filters', filters);
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
        log.debug('STEP 8', 'Sales Order search created');
        const results = salesOrderSearch.run().getRange({
            start: 0,
            end: 1
        });
        log.debug('STEP 9 - Search Completed', {
            resultCount: results.length
        });
        if (results.length > 0) {
            const duplicateId = results[0].getValue({
                name: 'internalid'
            });
            const soNumber = results[0].getValue({
                name: 'tranid'
            });
            const duplicatePO = results[0].getValue({
                name: 'otherrefnum'
            });
            log.debug('STEP 10 - Duplicate Found', {
                internalId: duplicateId,
                salesOrder: soNumber,
                poNumber: duplicatePO
            });
            alert(
                'Duplicate PO Number Found.\n\n' +
                'PO # ' + po +
                ' already exists on Sales Order ' + soNumber +
                '.\n\nPlease enter a different PO number.'
            );
            log.debug('STEP 11', 'Save blocked because duplicate PO was found');
            return false;
        }
        log.debug('STEP 10 - No Duplicate', {
            po: po,
            message: 'No other Sales Order found with this PO number'
        });
        log.debug('STEP 11', 'Sales Order save allowed');
        return true;
    };
    return {
        saveRecord: saveRecord
    };
});