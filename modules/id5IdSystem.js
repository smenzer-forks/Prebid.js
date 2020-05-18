/**
 * This module adds ID5 to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/id5IdSystem
 * @requires module:modules/userId
 */

import * as utils from '../src/utils.js'
import { ajax } from '../src/ajax.js';
import { submodule } from '../src/hook.js';
import { getRefererInfo } from '../src/refererDetection.js';
import { getStorageManager } from '../src/storageManager.js';

const MODULE_NAME = 'id5Id';
const GVLID = 131;
const BASE_NB_COOKIE_NAME = 'id5id.1st';
const NB_COOKIE_EXP_DAYS = (30 * 24 * 60 * 60 * 1000); // 30 days

const storage = getStorageManager(GVLID, MODULE_NAME);

/** @type {Submodule} */
export const id5IdSubmodule = {
  /**
   * used to link submodule with config
   * @type {string}
   */
  name: 'id5Id',

  /**
   * Vendor id of ID5
   * @type {Number}
   */
  gvlid: GVLID,

  /**
   * decode the stored id value for passing to bid requests
   * @function decode
   * @param {(Object|string)} value
   * @returns {(Object|undefined)}
   */
  decode(value) {
    let decodedObject;

    if (value && typeof value.ID5ID === 'string') {
      // don't lose our legacy value from cache
      decodedObject = { id5id: { universal_uid: value.ID5ID } };
    } else if (value && typeof value.universal_uid === 'string') {
      decodedObject = { id5id: { universal_uid: value.universal_uid } };
    } else {
      return undefined;
    }

    if (value.novatiq_snowflake_id && typeof value.novatiq_snowflake_id === 'string') {
      decodedObject.id5id.ext = {
        novatiq_snowflake_id: value.novatiq_snowflake_id
      };
    }

    return decodedObject;
  },

  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function getId
   * @param {SubmoduleParams} [configParams]
   * @param {ConsentData} [consentData]
   * @param {(Object|undefined)} cacheIdObj
   * @returns {IdResponse|undefined}
   */
  getId(configParams, consentData, cacheIdObj) {
    if (!hasRequiredParams(configParams)) {
      return undefined;
    }
    const hasGdpr = (consentData && typeof consentData.gdprApplies === 'boolean' && consentData.gdprApplies) ? 1 : 0;
    const gdprConsentString = hasGdpr ? consentData.consentString : '';
    const url = `https://id5-sync.com/g/v2/${configParams.partner}.json?gdpr_consent=${gdprConsentString}&gdpr=${hasGdpr}`;
    const referer = getRefererInfo();
    const signature = (cacheIdObj && cacheIdObj.signature) ? cacheIdObj.signature : '';
    const pubId = (cacheIdObj && cacheIdObj.ID5ID) ? cacheIdObj.ID5ID : ''; // TODO: remove when 1puid isn't needed
    const data = {
      'partner': configParams.partner,
      '1puid': pubId, // TODO: remove when 1puid isn't needed
      'nbPage': incrementNb(configParams),
      'o': 'pbjs',
      'pd': configParams.pd || '',
      'rf': referer.referer,
      's': signature,
      'top': referer.reachedTop ? 1 : 0,
      'u': referer.stack[0] || window.location.href,
      'v': '$prebid.version$'
    };

    const resp = function (callback) {
      const callbacks = {
        success: response => {
          let responseObj;
          if (response) {
            try {
              responseObj = JSON.parse(response);
              if (responseObj.id5_consent === true && isNovatiqEnabled(configParams)) {
                responseObj.novatiq_snowflake_id = fireNovatiqSyncRequest(responseObj.universal_uid, configParams.partner);
              }
              resetNb(configParams);
            } catch (error) {
              utils.logError(error);
            }
          }
          callback(responseObj);
        },
        error: error => {
          utils.logError(`id5Id: ID fetch encountered an error`, error);
          callback();
        }
      };
      ajax(url, callbacks, JSON.stringify(data), { method: 'POST', withCredentials: true });
    };
    return {callback: resp};
  },

  /**
   * Similar to Submodule#getId, this optional method returns response to for id that exists already.
   *  If IdResponse#id is defined, then it will be written to the current active storage even if it exists already.
   *  If IdResponse#callback is defined, then it'll called at the end of auction.
   *  It's permissible to return neither, one, or both fields.
   * @function extendId
   * @param {SubmoduleParams} configParams
   * @param {Object} cacheIdObj - existing id, if any
   * @return {(IdResponse|function(callback:function))} A response object that contains id and/or callback.
   */
  extendId(configParams, cacheIdObj) {
    incrementNb(configParams);
    if (cacheIdObj.id5_consent === true && isNovatiqEnabled(configParams)) {
      cacheIdObj.novatiq_snowflake_id = fireNovatiqSyncRequest(cacheIdObj.universal_uid, configParams.partner);
    }
    return cacheIdObj;
  }
};

function hasRequiredParams(configParams) {
  if (!configParams || typeof configParams.partner !== 'number') {
    utils.logError(`User ID - ID5 submodule requires partner to be defined as a number`);
    return false;
  }
  return true;
}
function nbCookieName(configParams) {
  return hasRequiredParams(configParams) ? `${BASE_NB_COOKIE_NAME}_${configParams.partner}_nb` : undefined;
}
function nbCookieExpStr(expDays) {
  return (new Date(Date.now() + expDays)).toUTCString();
}
function storeNbInCookie(configParams, nb) {
  storage.setCookie(nbCookieName(configParams), nb, nbCookieExpStr(NB_COOKIE_EXP_DAYS), 'Lax');
}
function getNbFromCookie(configParams) {
  const cacheNb = storage.getCookie(nbCookieName(configParams));
  return (cacheNb) ? parseInt(cacheNb) : 0;
}
function incrementNb(configParams) {
  const nb = (getNbFromCookie(configParams) + 1);
  storeNbInCookie(configParams, nb);
  return nb;
}
function resetNb(configParams) {
  storeNbInCookie(configParams, 0);
}
function isNovatiqEnabled(config) {
  return (config && config.vendors && config.vendors.novatiq && config.vendors.novatiq === true);
}
function generateSnowflakeId() {
  const genRandHex = size => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return utils.generateUUID() + genRandHex(4);
}
function fireNovatiqSyncRequest(id5Id, partner) {
  const endpoint = 'https://spadsync.com/sync';
  const sspid = 'id5';
  const ssphost = 'id5-sync.com';
  const snowflakeId = generateSnowflakeId();

  ajax(endpoint, () => {}, {
    sptoken: snowflakeId,
    sspid: sspid,
    ssphost: ssphost,
    id5id: id5Id,
    pubid: partner
  }, { method: 'GET', withCredentials: true });

  return snowflakeId;
}

submodule('userId', id5IdSubmodule);
