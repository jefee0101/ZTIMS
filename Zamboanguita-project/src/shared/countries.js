/* ==========================================================================
   Countries, for the one place ZTIMS asks for one
   --------------------------------------------------------------------------
   A guide booking records the visitor's nationality because the Municipal
   Tourism Office reports domestic and foreign arrivals upward, and a free-text
   box cannot be counted: "Filipino", "filipino", "PH", "Pinoy" and "Philipines"
   are five nationalities as far as any total is concerned.

   So the visitor picks from a list and ZTIMS stores the ISO 3166-1 alpha-2
   code. The code is what survives a country being renamed; the name here is
   only how it is shown.

   The backend keeps the same set of codes in server.js and validates against
   it, because nothing arriving from a browser can be taken on trust. The two
   deploy separately, so they cannot share this file — scripts/check-countries.cjs
   compares them instead.
   ========================================================================== */

(function () {
    'use strict';

    // code:name, packed rather than 249 object literals. Split once below.
    var PACKED =
        'AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua and Barbuda|AI:Anguilla|AL:Albania|' +
        'AM:Armenia|AO:Angola|AQ:Antarctica|AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|' +
        'AW:Aruba|AX:Åland Islands|AZ:Azerbaijan|BA:Bosnia and Herzegovina|BB:Barbados|BD:Bangladesh|' +
        'BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:Saint Barthélemy|' +
        'BM:Bermuda|BN:Brunei|BO:Bolivia|BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|' +
        'BV:Bouvet Island|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CC:Cocos (Keeling) Islands|' +
        'CD:Congo (Kinshasa)|CF:Central African Republic|CG:Congo (Brazzaville)|CH:Switzerland|' +
        'CI:Côte d\'Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|' +
        'CU:Cuba|CV:Cabo Verde|CW:Curaçao|CX:Christmas Island|CY:Cyprus|CZ:Czechia|DE:Germany|' +
        'DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|' +
        'EG:Egypt|EH:Western Sahara|ER:Eritrea|ES:Spain|ET:Ethiopia|FI:Finland|FJ:Fiji|' +
        'FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|GB:United Kingdom|' +
        'GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|' +
        'GN:Guinea|GP:Guadeloupe|GQ:Equatorial Guinea|GR:Greece|' +
        'GS:South Georgia and the South Sandwich Islands|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|' +
        'HK:Hong Kong|HM:Heard Island and McDonald Islands|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|' +
        'ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IO:British Indian Ocean Territory|' +
        'IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|' +
        'KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:Saint Kitts and Nevis|KP:North Korea|' +
        'KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:Saint Lucia|' +
        'LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|' +
        'LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:Saint Martin|MG:Madagascar|' +
        'MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macao|' +
        'MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|MS:Montserrat|MT:Malta|MU:Mauritius|' +
        'MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|' +
        'NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|' +
        'NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|' +
        'PK:Pakistan|PL:Poland|PM:Saint Pierre and Miquelon|PN:Pitcairn|PR:Puerto Rico|PS:Palestine|' +
        'PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RE:Réunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|' +
        'SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|' +
        'SH:Saint Helena|SI:Slovenia|SJ:Svalbard and Jan Mayen|SK:Slovakia|SL:Sierra Leone|SM:San Marino|' +
        'SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|ST:Sao Tome and Principe|SV:El Salvador|' +
        'SX:Sint Maarten|SY:Syria|SZ:Eswatini|TC:Turks and Caicos Islands|TD:Chad|' +
        'TF:French Southern Territories|TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|' +
        'TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Türkiye|TT:Trinidad and Tobago|TV:Tuvalu|TW:Taiwan|' +
        'TZ:Tanzania|UA:Ukraine|UG:Uganda|UM:United States Minor Outlying Islands|US:United States|' +
        'UY:Uruguay|UZ:Uzbekistan|VA:Holy See|VC:Saint Vincent and the Grenadines|VE:Venezuela|' +
        'VG:British Virgin Islands|VI:U.S. Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis and Futuna|' +
        'WS:Samoa|YE:Yemen|YT:Mayotte|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe';

    /* Offered at the top as well as in place. Nearly every booking is domestic,
       and Korea, China, the United States and Japan are the steady sources of
       the rest — scrolling to P for the common case is friction with no purpose.
       Each also appears in the full list, so there is no wrong way to find one. */
    var FREQUENT = ['PH', 'KR', 'CN', 'US', 'JP', 'AU', 'GB', 'CA', 'DE', 'TW'];

    var LIST = PACKED.split('|').map(function (entry) {
        var cut = entry.indexOf(':');
        return { code: entry.slice(0, cut), name: entry.slice(cut + 1) };
    });

    var BY_CODE = {};
    LIST.forEach(function (row) { BY_CODE[row.code] = row.name; });

    function nameOf(code) {
        return BY_CODE[String(code || '').trim().toUpperCase()] || '';
    }

    function isCode(code) {
        return Object.prototype.hasOwnProperty.call(BY_CODE, String(code || '').trim().toUpperCase());
    }

    function option(row) {
        var el = document.createElement('option');
        el.value = row.code;
        el.textContent = row.name;      // textContent, so a name is never markup
        return el;
    }

    /* Fills a <select>. The placeholder is deliberately not a country: a
       pre-selected Philippines would be recorded as a Filipino visitor every
       time somebody did not look at this field, which is exactly the number the
       office is trying to find out. */
    function fillSelect(select, config) {
        if (!select) return;
        var settings = config || {};
        select.innerHTML = '';

        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = settings.placeholder || 'Select nationality\u2026';
        select.appendChild(placeholder);

        var common = document.createElement('optgroup');
        common.label = 'Most often seen';
        FREQUENT.forEach(function (code) {
            if (BY_CODE[code]) common.appendChild(option({ code: code, name: BY_CODE[code] }));
        });
        select.appendChild(common);

        var all = document.createElement('optgroup');
        all.label = 'All countries';
        LIST.forEach(function (row) { all.appendChild(option(row)); });
        select.appendChild(all);

        if (settings.selected && isCode(settings.selected)) {
            select.value = String(settings.selected).toUpperCase();
        }
    }

    window.ZTIMS_COUNTRIES = {
        LIST: LIST,
        FREQUENT: FREQUENT,
        nameOf: nameOf,
        isCode: isCode,
        fillSelect: fillSelect
    };
})();
