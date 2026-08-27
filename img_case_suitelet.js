/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * TAGeX — Case Form Suitelet (v5)
 *
 * Entity resolution (mirrors NetSuite's own case capture behaviour):
 *   1 customer matches the email       -> use it
 *   2+ customers match                 -> ask the submitter which one (email is not unique here)
 *   0 customers, contact with company   -> use the contact's company, attach the contact
 *   nothing usable                      -> anonymous/fallback customer, or create a lead
 *
 * A case is never abandoned just because the sender is unknown.
 *
 * Page flow uses POST-Redirect-GET:
 *   GET  (no params) -> the form
 *   POST             -> create the case, email the team, then REDIRECT
 *   GET  ?st=ok|err  -> result page only, no form. Refreshing cannot resubmit.
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/email', 'N/url', 'N/runtime', 'N/redirect', 'N/log'],
  function (serverWidget, record, search, email, url, runtime, redirect, log) {

    // ── CONFIG — re-verify every internal ID after a sandbox refresh ──
    var CFG = {
      EMAIL_AUTHOR_ID: 3158,                        // must be an EMPLOYEE internal id
      NOTIFY_TO: ['dsoni@oncloudconsulting.ca'],

      CASE_CUSTOM_FORM: null,                       // e.g. 123 — null = default case form
      CASE_PROFILE: null,                           // Setup > Support > Case Profiles
      CASE_STATUS: 1,                               // 1 = Not Started
      CASE_ORIGIN: null,                            // internal id of "Web", or null
      CASE_PRIORITY: 2,                             // 1 High, 2 Medium, 3 Low

      // Anonymous / placeholder customer, used when the email matches nothing.
      // Setup > Support > Case Profiles > General subtab holds the one NetSuite uses natively.
      FALLBACK_CUSTOMER_ID: null,

      // If true and there is no fallback customer, create a Lead and use it as the company.
      CREATE_LEAD_ON_NO_MATCH: false,
      DEFAULT_SUBSIDIARY_ID: null,                  // needed for lead creation in OneWorld

      MAX_MATCHES: 25,

      CASE_LINK_BASE: 'https://4382108-sb1.app.netsuite.com/app/crm/support/supportcase.nl?id=',

      TEST_MODE: false
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

    function suiteletUrl() {
      return url.resolveScript({
        scriptId: runtime.getCurrentScript().id,
        deploymentId: runtime.getCurrentScript().deploymentId,
        returnExternalUrl: true
      });
    }

    function errText(e) {
      if (!e) return 'Unknown error';
      return String(e.message || e.name || e).substring(0, 300);
    }

    // ── Lookup ───────────────────────────────────────────────────
    function findCustomers(emailAddr) {
      if (!emailAddr) return [];

      var out = [];
      search.create({
        type: search.Type.CUSTOMER,
        filters: [['email', 'is', emailAddr], 'AND', ['isinactive', 'is', 'F']],
        columns: ['internalid', 'entityid', 'companyname', 'parent']
      }).run().each(function (r) {
        out.push({
          id: r.getValue('internalid'),
          entityid: r.getValue('entityid'),
          name: r.getValue('companyname') || r.getValue('entityid'),
          parent: r.getText('parent') || ''
        });
        return out.length < CFG.MAX_MATCHES;
      });

      return out;
    }

    function findContact(emailAddr) {
      if (!emailAddr) return null;

      var res = search.create({
        type: search.Type.CONTACT,
        filters: [['email', 'is', emailAddr], 'AND', ['isinactive', 'is', 'F']],
        columns: ['internalid', 'entityid', 'company']
      }).run().getRange({ start: 0, end: 1 });

      if (!res || !res.length) return null;

      return {
        id: res[0].getValue('internalid'),
        name: res[0].getValue('entityid'),
        companyId: res[0].getValue('company') || null
      };
    }

    function matchLabelFor(c) {
      var label = c.entityid ? (c.entityid + ' — ' + c.name) : c.name;
      return c.parent ? label + '  (under ' + c.parent + ')' : label;
    }

    function createLeadFallback(d) {
      var lead = record.create({ type: record.Type.LEAD });

      lead.setValue({
        fieldId: 'companyname',
        value: (d.firstname + ' ' + d.lastname).trim() || d.email || 'Website enquiry'
      });

      if (CFG.DEFAULT_SUBSIDIARY_ID) {
        lead.setValue({ fieldId: 'subsidiary', value: CFG.DEFAULT_SUBSIDIARY_ID });
      }

      if (d.email) lead.setValue({ fieldId: 'email', value: d.email });
      if (d.phone) { try { lead.setValue({ fieldId: 'phone', value: d.phone }); } catch (e) {} }

      var id = lead.save({ enableSourcing: true, ignoreMandatoryFields: true });
      log.audit('Lead created for unmatched submitter', id);
      return id;
    }

    // Returns { decided:true, entity:{...} } or { decided:false, customers:[...] }
    function resolveEntity(d) {
      // Second step — the submitter already chose an account.
      if (d.chosenCustomerId && d.chosenCustomerId !== 'NONE') {
        return {
          decided: true,
          entity: {
            customerId: d.chosenCustomerId,
            contactId: null,
            how: 'Chosen by the submitter from ' + (d.matchCount || 'several') + ' accounts sharing this email'
          }
        };
      }

      var pickedNone = (d.chosenCustomerId === 'NONE');

      if (!pickedNone) {
        var customers = findCustomers(d.email);
        log.audit('Customer matches', { email: d.email, count: customers.length });

        if (customers.length > 1) return { decided: false, customers: customers };

        if (customers.length === 1) {
          return {
            decided: true,
            entity: {
              customerId: customers[0].id,
              contactId: null,
              how: 'Single customer match on email: ' + matchLabelFor(customers[0])
            }
          };
        }

        var contact = findContact(d.email);
        if (contact && contact.companyId) {
          return {
            decided: true,
            entity: {
              customerId: contact.companyId,
              contactId: contact.id,   // safe: the contact belongs to this company
              how: 'Matched contact ' + contact.name + ' under company #' + contact.companyId
            }
          };
        }
      }

      // Nothing usable — placeholder customer, or a new lead.
      var reason = pickedNone
        ? 'Submitter said none of the matching accounts was theirs'
        : 'No customer or company match for this email';

      if (CFG.FALLBACK_CUSTOMER_ID) {
        return {
          decided: true,
          entity: {
            customerId: CFG.FALLBACK_CUSTOMER_ID,
            contactId: null,
            how: reason + ' — anonymous/fallback customer used'
          }
        };
      }

      if (CFG.CREATE_LEAD_ON_NO_MATCH) {
        var leadId = createLeadFallback(d);
        return {
          decided: true,
          entity: {
            customerId: leadId,
            contactId: null,
            how: reason + ' — new lead #' + leadId + ' created and used as the company'
          }
        };
      }

      // No company at all. In OneWorld the case cannot source a subsidiary and the
      // save will fail — this is exactly why FALLBACK_CUSTOMER_ID matters.
      return {
        decided: true,
        entity: {
          customerId: null,
          contactId: null,
          how: reason + ' — NO COMPANY SET (configure FALLBACK_CUSTOMER_ID)'
        }
      };
    }

    // ── Create the case ──────────────────────────────────────────
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
        if (CFG.CASE_PROFILE)  rec.setValue({ fieldId: 'profile',  value: CFG.CASE_PROFILE });
        if (CFG.CASE_PRIORITY) rec.setValue({ fieldId: 'priority', value: CFG.CASE_PRIORITY });
        if (CFG.CASE_STATUS)   rec.setValue({ fieldId: 'status',   value: CFG.CASE_STATUS });
        if (CFG.CASE_ORIGIN)   rec.setValue({ fieldId: 'origin',   value: CFG.CASE_ORIGIN });
      }

      return rec;
    }

    function createCase(d, entity) {
      // Field validation runs at save(), not setValue(). The first attempt keeps
      // mandatory-field validation ON so the log shows a readable reason; later
      // attempts drop optional fields and relax validation.
      var attempts = [
        { withContact: true,  withOptionalLists: true,  ignoreMandatory: false, label: 'full' },
        { withContact: false, withOptionalLists: true,  ignoreMandatory: false, label: 'without contact' },
        { withContact: false, withOptionalLists: false, ignoreMandatory: true,  label: 'minimum fields' }
      ];

      var lastError = null;

      for (var i = 0; i < attempts.length; i++) {
        try {
          var caseId = buildCase(d, entity, attempts[i]).save({
            enableSourcing: true,
            ignoreMandatoryFields: attempts[i].ignoreMandatory
          });
          log.audit('Case created', { caseId: caseId, attempt: attempts[i].label, entity: entity });
          return { caseId: caseId, attempt: attempts[i].label };
        } catch (e) {
          lastError = e;
          log.error('Case save failed (' + attempts[i].label + ')', errText(e));
        }
      }

      throw lastError;
    }

    // ── Notification ─────────────────────────────────────────────
    function row(label, value) {
      return '<tr>'
        + '<td style="padding:8px;border:1px solid #ddd;font-weight:bold;width:170px;">' + esc(label) + '</td>'
        + '<td style="padding:8px;border:1px solid #ddd;">' + esc(value || '-') + '</td>'
        + '</tr>';
    }

    function sendNotification(d, entity, result, error) {
      var table = '<table style="border-collapse:collapse;width:100%;max-width:640px;font-family:Arial,sans-serif;font-size:14px;">'
        + row('Name', (d.firstname + ' ' + d.lastname).trim())
        + row('Email', d.email)
        + row('Phone', d.phone)
        + row('Subject', d.subject)
        + row('Message', d.message)
        + row('Account matching', entity.how)
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
        body = '<p>A website submission could not be turned into a case. The details are below so nothing is lost.</p>'
          + table + '<p><b>Error:</b> ' + esc(errText(error)) + '</p>';
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
        log.error('Notification failed', errText(e));
      }
    }

    // ── Shared markup ────────────────────────────────────────────
    var STYLES = `
<style>
  html,body{margin:0!important;padding:0!important;box-sizing:border-box;}
  .wrap{display:flex;justify-content:center;align-items:flex-start;}
  .card{width:100%;max-width:460px;background:#fff;padding:20px 25px;border-radius:10px;font-family:Arial,sans-serif;}
  .fg{display:flex;flex-direction:column;margin-bottom:12px;}
  .fg label{margin-bottom:5px;font-weight:bold;font-size:14px;}
  .fg input,.fg select{padding:10px;font-size:14px;border-radius:4px;border:1px solid #ccc;width:100%;height:44px;box-sizing:border-box;}
  .fg textarea{padding:8px;font-size:14px;border-radius:4px;border:1px solid #ccc;width:100%;min-height:90px;box-sizing:border-box;resize:vertical;font-family:Arial,sans-serif;}
  .hint{display:block;color:#6c757d;font-size:.85em;margin-bottom:4px;}
  h3{font-family:Arial,sans-serif;font-size:17px;margin:0 0 6px;}
  button[type=submit]{padding:14px;font-size:14px;border-radius:6px;border:none;background:linear-gradient(135deg,#0b3d91,#072b66);color:#fff;cursor:pointer;width:100%;font-weight:600;margin-top:8px;}
  .result{text-align:center;padding:40px 25px;font-family:Arial,sans-serif;max-width:520px;margin:0 auto;}
  .result h2{margin:0 0 12px;font-size:22px;}
  .result p{font-size:16px;color:#555;margin:6px 0;}
  .case-no{display:inline-block;margin-top:10px;padding:10px 18px;border-radius:6px;background:#f1f5fb;font-size:18px;font-weight:700;color:#0b3d91;}
  .again{display:inline-block;margin-top:22px;font-size:14px;color:#0b3d91;}
  #ldr{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;}
  #ldr.on{display:block;}
  .sp{border:8px solid #f3f3f3;border-top:8px solid #3498db;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite;position:absolute;top:50%;left:50%;margin:-25px 0 0 -25px;}
  @keyframes spin{to{transform:rotate(360deg);}}
</style>`;

    var LOADER = `
<div id="ldr"><div class="sp"></div></div>
<script>
document.addEventListener('submit', function(){
  var l = document.getElementById('ldr');
  if (l) l.className = 'on';
}, true);
</script>`;

    // ── Page 1: the form ─────────────────────────────────────────
    function formHtml() {
      return STYLES + `
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
      <span class="hint">We use this to match you to your account.</span>
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
  </div>
</div>` + LOADER;
    }

    // ── Page 2: picker, shown only when the email is ambiguous ───
    function hidden(name, value) {
      return '<input type="hidden" name="' + name + '" value="' + esc(value) + '">';
    }

    function pickerHtml(d, customers) {
      var options = '';
      for (var i = 0; i < customers.length; i++) {
        options += '<option value="' + esc(customers[i].id) + '">' + esc(matchLabelFor(customers[i])) + '</option>';
      }
      options += '<option value="NONE">My organization is not listed</option>';

      return '<!doctype html><meta charset="utf-8">' + STYLES + `
<div class="wrap">
  <div class="card">
    <form method="POST" action="${esc(suiteletUrl())}">

      <h3>One more thing</h3>
      <p class="hint" style="margin-bottom:16px;">
        This email address is on more than one account. Choose the one your request
        relates to so the case reaches the right team.
      </p>

      ${hidden('custpage_firstname', d.firstname)}
      ${hidden('custpage_lastname', d.lastname)}
      ${hidden('custpage_email', d.email)}
      ${hidden('custpage_phone', d.phone)}
      ${hidden('custpage_subject', d.subject)}
      ${hidden('custpage_message', d.message)}
      ${hidden('custpage_matchcount', customers.length)}

      <div class="fg">
        <label>Your organization *</label>
        <select name="custpage_customerid" required>
          <option value="">Select...</option>
          ${options}
        </select>
      </div>

      <button type="submit">Continue</button>
    </form>
  </div>
</div>` + LOADER;
    }

    // ── Page 3: result only — no form, refresh-safe ──────────────
    function resultPage(status, caseId, errMsg) {
      var backLink = '<a class="again" href="' + esc(suiteletUrl()) + '">Submit another case</a>';

      if (status === 'ok') {
        return '<!doctype html><meta charset="utf-8">' + STYLES
          + '<div class="result">'
          + '<h2 style="color:#2e7d32;">Your case has been created</h2>'
          + '<p>Thanks — our team has been notified and will be in touch.</p>'
          + (caseId ? '<div class="case-no">Case #' + esc(caseId) + '</div>' : '')
          + '<p style="margin-top:18px;font-size:14px;">Please quote this number in any follow-up.</p>'
          + backLink
          + '</div>';
      }

      return '<!doctype html><meta charset="utf-8">' + STYLES
        + '<div class="result">'
        + '<h2 style="color:#b00020;">We could not open a case</h2>'
        + '<p>Your details did reach our team by email, so nothing is lost — someone will follow up with you.</p>'
        + (errMsg ? '<p style="font-size:13px;color:#999;margin-top:16px;">Reason: ' + esc(errMsg) + '</p>' : '')
        + backLink
        + '</div>';
    }

    // ── Entry point ──────────────────────────────────────────────
    function onRequest(context) {
      var req = context.request;
      var res = context.response;

      if (req.method === 'GET') {
        var status = p(req, 'st');

        // Result page — reached only via the redirect after a POST.
        if (status) {
          log.audit('Result page', { st: status, cid: p(req, 'cid') });
          res.write(resultPage(status, p(req, 'cid'), p(req, 'msg')));
          return;
        }

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
          message:   p(req, 'custpage_message'),
          chosenCustomerId: p(req, 'custpage_customerid'),
          matchCount: p(req, 'custpage_matchcount')
        };

        if (!d.subject) d.subject = 'Website enquiry — ' + (d.firstname + ' ' + d.lastname).trim();

        log.audit('CASE POST', d);

        var resolved = resolveEntity(d);

        // Ambiguous email — ask, then wait for the second POST.
        if (!resolved.decided) {
          log.audit('Ambiguous email — showing picker', { email: d.email, options: resolved.customers.length });
          res.write(pickerHtml(d, resolved.customers));
          return;
        }

        var entity = resolved.entity;

        if (CFG.TEST_MODE) {
          res.write('<pre style="white-space:pre-wrap;font-family:monospace;">'
            + esc(JSON.stringify({ form: d, entity: entity }, null, 2)) + '</pre>');
          return;
        }

        var result = null;
        var failure = null;

        try {
          result = createCase(d, entity);
        } catch (e) {
          failure = e;
          log.error('Case creation failed after all attempts', errText(e));
        }

        sendNotification(d, entity, result, failure);

        // POST-Redirect-GET: the browser lands on a plain GET, so refreshing
        // re-renders the result instead of creating a second case.
        redirect.toSuitelet({
          scriptId: runtime.getCurrentScript().id,
          deploymentId: runtime.getCurrentScript().deploymentId,
          parameters: (result && result.caseId)
            ? { st: 'ok',  cid: result.caseId }
            : { st: 'err', msg: errText(failure) }
        });
        return;
      }
    }

    return { onRequest: onRequest };
  });