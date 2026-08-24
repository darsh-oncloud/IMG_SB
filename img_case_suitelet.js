/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * TAGeX — Simple Case Form Suitelet (v2)
 *
 * Flow:
 *   GET  -> render the form
 *   POST -> search Customer by email, else Contact by email
 *           -> attach Company (and Contact only when it belongs to that Company)
 *           -> create the Case (with a retry that drops optional fields if NetSuite rejects them)
 *           -> email the internal team
 *           -> show the case number on success, or an honest error page on failure
 *
 * Fixes vs v1:
 *   - A Contact is only attached when the Case has a Company and the Contact belongs to it.
 *     NetSuite validates the contact against the company at save(), not at setValue().
 *   - save() is retried without optional fields instead of failing outright.
 *   - The thank-you page no longer appears when the case was not created.
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/email', 'N/log'],
  function (serverWidget, record, search, email, log) {

    // ── CONFIG ───────────────────────────────────────────────────
    var CFG = {
      EMAIL_AUTHOR_ID: 3158,                        // must be an EMPLOYEE internal id
      NOTIFY_TO: ['dsoni@oncloudconsulting.ca'],

      CASE_CUSTOM_FORM: null,                       // e.g. 123 — null = default case form
      CASE_STATUS: 1,                               // 1 = Not Started
      CASE_ORIGIN: null,                            // internal id of "Web", or null
      CASE_PRIORITY: 2,                             // 1 High, 2 Medium, 3 Low

      // Used when the email matches nothing, or matches a contact with no parent company.
      // Cases usually require a Company — point this at a generic "Website Enquiries" customer.
      FALLBACK_CUSTOMER_ID: null,

      CASE_LINK_BASE: 'https://4382108-sb1.app.netsuite.com/app/crm/support/supportcase.nl?id=',

      TEST_MODE: false                              // true = print the lookup result, create nothing
    };

    // ── Helpers ──────────────────────────────────────────────────
    function esc(s) {
      s = (s == null ? '' : String(s));
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function p(req, key) {
      return (req.parameters && req.parameters[key] ? String(req.parameters[key]) : '').trim();
    }

    // ── Step 1: find the entity by email ─────────────────────────
    // 'customer' search covers Customers, Leads and Prospects.
    function findCustomerByEmail(emailAddr) {
      var res = search.create({
        type: search.Type.CUSTOMER,
        filters: [['email', 'is', emailAddr], 'AND', ['isinactive', 'is', 'F']],
        columns: ['internalid', 'entityid', 'companyname']
      }).run().getRange({ start: 0, end: 1 });

      if (!res || !res.length) return null;

      return {
        source: 'customer',
        customerId: res[0].getValue('internalid'),
        contactId: null,
        name: res[0].getValue('companyname') || res[0].getValue('entityid'),
        note: ''
      };
    }

    function findContactByEmail(emailAddr) {
      var res = search.create({
        type: search.Type.CONTACT,
        filters: [['email', 'is', emailAddr], 'AND', ['isinactive', 'is', 'F']],
        columns: ['internalid', 'entityid', 'company']
      }).run().getRange({ start: 0, end: 1 });

      if (!res || !res.length) return null;

      var companyId = res[0].getValue('company') || null;

      return {
        source: 'contact',
        customerId: companyId,
        // A contact can only go on the case when it has a parent company — NetSuite
        // validates the contact against the company and rejects orphans at save().
        contactId: companyId ? res[0].getValue('internalid') : null,
        name: res[0].getValue('entityid'),
        note: companyId ? '' : 'Contact has no parent company, so it was not attached to the case.'
      };
    }

    function lookupEntity(emailAddr) {
      var empty = { source: 'none', customerId: null, contactId: null, name: '', note: '' };
      if (!emailAddr) return empty;

      var hit = findCustomerByEmail(emailAddr) || findContactByEmail(emailAddr) || empty;

      // No usable company? Fall back to the generic customer if one is configured.
      if (!hit.customerId && CFG.FALLBACK_CUSTOMER_ID) {
        hit.customerId = CFG.FALLBACK_CUSTOMER_ID;
        hit.note = (hit.note ? hit.note + ' ' : '') + 'Fallback customer used as the case company.';
      }

      log.audit('Entity lookup result', hit);
      return hit;
    }

    // ── Step 2: create the case ──────────────────────────────────
    // opts lets the retry drop whatever NetSuite objected to.
    function buildCase(d, entity, opts) {
      var rec = record.create({ type: record.Type.SUPPORT_CASE });

      if (CFG.CASE_CUSTOM_FORM) rec.setValue({ fieldId: 'customform', value: CFG.CASE_CUSTOM_FORM });

      if (entity.customerId) rec.setValue({ fieldId: 'company', value: entity.customerId });
      if (opts.withContact && entity.contactId && entity.customerId) {
        rec.setValue({ fieldId: 'contact', value: entity.contactId });
      }

      rec.setValue({ fieldId: 'title', value: d.subject });
      rec.setValue({ fieldId: 'incomingmessage', value: d.message });

      if (d.email) rec.setValue({ fieldId: 'email', value: d.email });
      if (d.phone) rec.setValue({ fieldId: 'phone', value: d.phone });

      if (opts.withOptionalLists) {
        if (CFG.CASE_PRIORITY) rec.setValue({ fieldId: 'priority', value: CFG.CASE_PRIORITY });
        if (CFG.CASE_STATUS)   rec.setValue({ fieldId: 'status',   value: CFG.CASE_STATUS });
        if (CFG.CASE_ORIGIN)   rec.setValue({ fieldId: 'origin',   value: CFG.CASE_ORIGIN });
      }

      return rec;
    }

    function createCase(d, entity) {
      // Each attempt drops one more optional piece. Field validation happens at save(),
      // so this is the only reliable way to find out what the account will accept.
      var attempts = [
        { withContact: true,  withOptionalLists: true,  label: 'full' },
        { withContact: false, withOptionalLists: true,  label: 'without contact' },
        { withContact: false, withOptionalLists: false, label: 'minimum fields' }
      ];

      var lastError = null;

      for (var i = 0; i < attempts.length; i++) {
        try {
          var rec = buildCase(d, entity, attempts[i]);
          var caseId = rec.save({ enableSourcing: true, ignoreMandatoryFields: true });
          log.audit('Case created', { caseId: caseId, attempt: attempts[i].label, entity: entity });
          return { caseId: caseId, attempt: attempts[i].label };
        } catch (e) {
          lastError = e;
          log.error('Case save failed (' + attempts[i].label + ')', e.message || e);
        }
      }

      throw lastError;
    }

    // ── Step 3: notify the team ──────────────────────────────────
    function row(label, value) {
      return '<tr>'
        + '<td style="padding:8px;border:1px solid #ddd;font-weight:bold;width:170px;">' + esc(label) + '</td>'
        + '<td style="padding:8px;border:1px solid #ddd;">' + esc(value || '-') + '</td>'
        + '</tr>';
    }

    function matchLabel(entity) {
      var base;
      if (entity.source === 'customer') {
        base = 'Customer #' + entity.customerId + ' (' + entity.name + ')';
      } else if (entity.source === 'contact') {
        base = 'Contact #' + (entity.contactId || 'n/a') + ' (' + entity.name + ')'
          + (entity.customerId ? ' under company #' + entity.customerId : ' with no parent company');
      } else {
        base = 'No match for this email address';
      }
      return entity.note ? base + ' — ' + entity.note : base;
    }

    function sendNotification(d, entity, result, error) {
      var table = '<table style="border-collapse:collapse;width:100%;max-width:640px;font-family:Arial,sans-serif;font-size:14px;">'
        + row('Name', (d.firstname + ' ' + d.lastname).trim())
        + row('Email', d.email)
        + row('Phone', d.phone)
        + row('Subject', d.subject)
        + row('Message', d.message)
        + row('NetSuite match', matchLabel(entity))
        + '</table>';

      var subject, body;

      if (result && result.caseId) {
        subject = 'New Case #' + result.caseId + ': ' + d.subject;
        body = '<p>A case was created from the website form.</p>' + table
          + '<p><a href="' + CFG.CASE_LINK_BASE + result.caseId + '" target="_blank">Open the case in NetSuite</a></p>'
          + (result.attempt !== 'full'
              ? '<p><i>Saved on the "' + esc(result.attempt) + '" attempt — some optional fields were dropped.</i></p>'
              : '');
      } else {
        subject = 'Case Creation FAILED: ' + d.email;
        body = '<p>The form was submitted but no case could be created. The details are below so nothing is lost.</p>'
          + table
          + '<p><b>Error:</b> ' + esc((error && error.message) ? error.message : 'Unknown error') + '</p>';
      }

      try {
        email.send({
          author: CFG.EMAIL_AUTHOR_ID,
          recipients: CFG.NOTIFY_TO,
          subject: subject,
          body: body,
          relatedRecords: entity.customerId ? { entityId: entity.customerId } : undefined,
          isInternalOnly: false
        });
        log.audit('Notification sent', subject);
      } catch (e) {
        log.error('Notification failed', e);
      }
    }

    // ── Form HTML ────────────────────────────────────────────────
    function formHtml() {
      return `
<style>
  html,body{margin:0!important;padding:0!important;box-sizing:border-box;}
  .wrap{display:flex;justify-content:center;align-items:flex-start;}
  .card{width:100%;max-width:460px;background:#fff;padding:20px 25px;border-radius:10px;font-family:Arial,sans-serif;}
  .fg{display:flex;flex-direction:column;margin-bottom:12px;}
  .fg label{margin-bottom:5px;font-weight:bold;font-size:14px;}
  .fg input{padding:10px;font-size:14px;border-radius:4px;border:1px solid #ccc;width:100%;height:44px;box-sizing:border-box;}
  .fg textarea{padding:8px;font-size:14px;border-radius:4px;border:1px solid #ccc;width:100%;min-height:90px;box-sizing:border-box;resize:vertical;font-family:Arial,sans-serif;}
  .hint{display:block;color:#6c757d;font-size:.85em;margin-bottom:4px;}
  button[type=submit]{padding:14px;font-size:14px;border-radius:6px;border:none;background:linear-gradient(135deg,#0b3d91,#072b66);color:#fff;cursor:pointer;width:100%;font-weight:600;margin-top:8px;}
  #ldr{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;}
  #ldr.on{display:block;}
  .sp{border:8px solid #f3f3f3;border-top:8px solid #3498db;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite;position:absolute;top:50%;left:50%;margin:-25px 0 0 -25px;}
  @keyframes spin{to{transform:rotate(360deg);}}
</style>

<div class="wrap">
  <div class="card">

    <div class="fg">
      <label>First name *</label>
      <input type="text" name="custpage_firstname" required autocomplete="given-name">
    </div>

    <div class="fg">
      <label>Last name *</label>
      <input type="text" name="custpage_lastname" required autocomplete="family-name">
    </div>

    <div class="fg">
      <label>Email *</label>
      <span class="hint">We use this to match you to your existing account.</span>
      <input type="email" name="custpage_email" required autocomplete="email">
    </div>

    <div class="fg">
      <label>Phone</label>
      <input type="tel" name="custpage_phone" placeholder="+1 555 123 4567" autocomplete="tel">
    </div>

    <div class="fg">
      <label>Subject *</label>
      <input type="text" name="custpage_subject" required>
    </div>

    <div class="fg">
      <label>How can we help? *</label>
      <textarea name="custpage_message" required></textarea>
    </div>

    <button type="submit">Submit case</button>
    <div id="ldr"><div class="sp"></div></div>
  </div>
</div>

<script>
document.addEventListener('submit', function(){
  var l = document.getElementById('ldr');
  if (l) l.className = 'on';
}, true);
</script>`;
    }

    function resultPage(caseId, error) {
      if (caseId) {
        return '<!doctype html><meta charset="utf-8">'
          + '<div style="font-family:Arial,sans-serif;text-align:center;margin-top:60px;">'
          + '<h2 style="color:#2e7d32;">Thanks — your case has been submitted.</h2>'
          + '<p style="font-size:16px;color:#555;">Reference number: <b>' + esc(caseId) + '</b></p>'
          + '<p style="font-size:16px;color:#555;">Someone from the team will get back to you shortly.</p>'
          + '</div>';
      }

      return '<!doctype html><meta charset="utf-8">'
        + '<div style="font-family:Arial,sans-serif;text-align:center;margin-top:60px;">'
        + '<h2 style="color:#b00020;">We could not open a case just now.</h2>'
        + '<p style="font-size:16px;color:#555;">Your details reached our team by email, so nothing is lost — someone will follow up.</p>'
        + '<p style="font-size:13px;color:#999;">Reason: ' + esc((error && error.message) ? error.message : 'Unknown error') + '</p>'
        + '</div>';
    }

    // ── Entry point ──────────────────────────────────────────────
    function onRequest(context) {
      var req = context.request;
      var res = context.response;

      log.audit('CASE SUITELET HIT', { method: req.method });

      if (req.method === 'GET') {
        var form = serverWidget.createForm({ title: '&nbsp;' });
        form.addField({
          id: 'custpage_case_html',
          type: serverWidget.FieldType.INLINEHTML,
          label: 'Case Form'
        }).defaultValue = formHtml();

        res.writePage(form);
        return;
      }

      if (req.method === 'POST') {
        var d = {
          firstname: p(req, 'custpage_firstname'),
          lastname:  p(req, 'custpage_lastname'),
          email:     p(req, 'custpage_email'),
          phone:     p(req, 'custpage_phone'),
          subject:   p(req, 'custpage_subject'),
          message:   p(req, 'custpage_message')
        };

        if (!d.subject) d.subject = 'Website enquiry — ' + (d.firstname + ' ' + d.lastname).trim();

        log.audit('CASE POST — parsed params', d);

        var entity = lookupEntity(d.email);

        if (CFG.TEST_MODE) {
          res.write('<pre style="white-space:pre-wrap;font-family:monospace;">'
            + esc(JSON.stringify({ form: d, match: entity }, null, 2)) + '</pre>');
          return;
        }

        var result = null;
        var failure = null;

        try {
          result = createCase(d, entity);
        } catch (e) {
          failure = e;
          log.error('Case creation failed after all attempts', e);
        }

        sendNotification(d, entity, result, failure);

        res.write(resultPage(result && result.caseId, failure));
        return;
      }
    }

    return { onRequest: onRequest };
  });