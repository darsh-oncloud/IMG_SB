/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/record'], function (search, record) {

    function afterSubmit(context) {

        if (context.type !== context.UserEventType.CREATE) return;

        try {
            var caseId = context.newRecord.getValue('custrecord_case');
            if (!caseId) return;

            var caseNumber = search.lookupFields({
                type: search.Type.SUPPORT_CASE,
                id: caseId,
                columns: ['casenumber']
            }).casenumber;

            if (!caseNumber) return;

            var folders = search.create({
                type: 'folder',
                filters: [
                    ['name', 'is', caseNumber],
                    'AND',
                    ['parent', 'anyof', '3347']
                ],
                columns: ['internalid']
            }).run().getRange({ start: 0, end: 1 });

            if (!folders.length) {
                log.audit('Case Folder Not Found', caseNumber);
                return;
            }

            var folderId = folders[0].id;

            var fileColumn = search.createColumn({
                name: 'internalid',
                join: 'file'
            });

            var attached = {};

            search.create({
                type: search.Type.SUPPORT_CASE,
                filters: [['internalid', 'anyof', caseId]],
                columns: [fileColumn]
            }).run().each(function (result) {
                var id = result.getValue(fileColumn);
                if (id) attached[id] = true;
                return true;
            });

            var added = 0;
            var skipped = 0;

            search.create({
                type: 'file',
                filters: [['folder', 'anyof', folderId]],
                columns: ['internalid']
            }).run().each(function (result) {

                var fileId = result.id;

                if (attached[fileId]) {
                    skipped++;
                    return true;
                }

                record.attach({
                    record: {
                        type: 'file',
                        id: fileId
                    },
                    to: {
                        type: record.Type.SUPPORT_CASE,
                        id: caseId
                    }
                });

                attached[fileId] = true;
                added++;
                return true;
            });

            log.audit('Case Files Sync', {
                caseNumber: caseNumber,
                folderId: folderId,
                added: added,
                skipped: skipped
            });

        } catch (e) {
            log.error('Case Files Sync Error', e);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});
