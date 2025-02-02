/* eslint-disable no-unused-vars */
const modulename = 'WebServer:MasterActions:Action';
import ConfigVault from '@core/components/ConfigVault';
import FXRunner from '@core/components/FxRunner';
import PlayerDatabase from '@core/components/PlayerDatabase';
import { DatabaseActionType, DatabasePlayerType } from '@core/components/PlayerDatabase/databaseTypes';
import logger, { ogConsole } from '@core/extras/console.js';
import { now } from '@core/extras/helpers';
import { GenericApiError } from '@shared/genericApiTypes';
import { Context } from 'koa';
const { dir, log, logOk, logWarn, logError } = logger(modulename);


/**
 * Handle all the master actions... actions
 * @param {object} ctx
 */
export default async function MasterActionsAction(ctx: Context) {
    //Sanity check
    if (typeof ctx.params.action !== 'string') {
        return ctx.send({error: 'Invalid Request'});
    }
    const action = ctx.params.action;

    //Check permissions
    if (!ctx.utils.testPermission('master', modulename)) {
        return ctx.send({error: 'Only the master account has permission to view/use this page.'});
    }
    if (!ctx.txVars.isWebInterface) {
        return ctx.send({error: 'This functionality cannot be used by the in-game menu, please use the web version of txAdmin.'});
    }

    //Delegate to the specific action functions
    if (action == 'reset_fxserver') {
        return await handleResetFXServer(ctx);
    } else if (action == 'cleanDatabase') {
        return handleCleanDatabase(ctx);
    } else if (action == 'revokeWhitelists') {
        return handleRevokeWhitelists(ctx);
    } else {
        return ctx.send({error: 'Unknown settings action.'});
    }
};


/**
 * Handle FXServer settings reset nad resurn to setup
 * @param {object} ctx
 */
async function handleResetFXServer(ctx: Context) {
    //Typescript stuff
    const fxRunner = (globals.fxRunner as FXRunner);
    const configVault = (globals.configVault as ConfigVault);

    if (fxRunner.fxChild !== null) {
        ctx.utils.logCommand('STOP SERVER');
        await fxRunner.killServer('resetting fxserver config', ctx.session.auth.username, false);
    }

    //Making sure the deployer is not running
    globals.deployer = null;

    //Preparing & saving config
    const newConfig = configVault.getScopedStructure('fxRunner');
    newConfig.serverDataPath = null;
    newConfig.cfgPath = null;
    const saveStatus = configVault.saveProfile('fxRunner', newConfig);

    //Sending output
    if (saveStatus) {
        fxRunner.refreshConfig();
        ctx.utils.logAction('Resetting fxRunner settings.');
        return ctx.send({ success: true });
    } else {
        logWarn(`[${ctx.session.auth.username}] Error resetting fxRunner settings.`);
        return ctx.send({ type: 'danger', message: '<strong>Error saving the configuration file.</strong>' });
    }
}


/**
 * Handle clean database request
 * @param {object} ctx
 */
async function handleCleanDatabase(ctx: Context) {
    //Typescript stuff
    const playerDatabase = (globals.playerDatabase as PlayerDatabase);
    type successResp = {
        msElapsed: number;
        playersRemoved: number;
        actionsRemoved: number;
    }
    const sendTypedResp = (data: successResp | GenericApiError) => ctx.send(data);

    //Sanity check
    if (
        typeof ctx.request.body.players !== 'string'
        || typeof ctx.request.body.bans !== 'string'
        || typeof ctx.request.body.warns !== 'string'
    ) {
        return sendTypedResp({error: 'xxxx'});
        return ctx.utils.error(400, 'Invalid Request');
    }
    const { players, bans, warns } = ctx.request.body;
    const daySecs = 86400;
    const currTs = now();

    //Prepare filters
    let playersFilter: Function;
    if (players === 'none') {
        playersFilter = (x: DatabasePlayerType) => false;
    } else if (players === '60d') {
        playersFilter = (x: DatabasePlayerType) => x.tsLastConnection < (currTs - 60 * daySecs) && !x.notes;
    } else if (players === '30d') {
        playersFilter = (x: DatabasePlayerType) => x.tsLastConnection < (currTs - 30 * daySecs) && !x.notes;
    } else if (players === '15d') {
        playersFilter = (x: DatabasePlayerType) => x.tsLastConnection < (currTs - 15 * daySecs) && !x.notes;
    } else {
        return sendTypedResp({error: 'Invalid players filter type.'});
    }

    let bansFilter: Function;
    if (bans === 'none') {
        bansFilter = (x: DatabaseActionType) => false;
    } else if (bans === 'revoked') {
        bansFilter = (x: DatabaseActionType) => x.type === 'ban' && x.revocation.timestamp;
    } else if (bans === 'revokedExpired') {
        bansFilter = (x: DatabaseActionType) => x.type === 'ban' && (x.revocation.timestamp || (x.expiration && x.expiration < currTs));
    } else if (bans === 'all') {
        bansFilter = (x: DatabaseActionType) => x.type === 'ban';
    } else {
        return sendTypedResp({error: 'Invalid bans filter type.'});
    }

    let warnsFilter: Function;
    if (warns === 'none') {
        warnsFilter = (x: DatabaseActionType) => false;
    } else if (warns === 'revoked') {
        warnsFilter = (x: DatabaseActionType) => x.type === 'warn' && x.revocation.timestamp;
    } else if (warns === '30d') {
        warnsFilter = (x: DatabaseActionType) => x.type === 'warn' && x.timestamp < (currTs - 30 * daySecs);
    } else if (warns === '15d') {
        warnsFilter = (x: DatabaseActionType) => x.type === 'warn' && x.timestamp < (currTs - 15 * daySecs);
    } else if (warns === '7d') {
        warnsFilter = (x: DatabaseActionType) => x.type === 'warn' && x.timestamp < (currTs - 7 * daySecs);
    } else if (warns === 'all') {
        warnsFilter = (x: DatabaseActionType) => x.type === 'warn';
    } else {
        return sendTypedResp({error: 'Invalid warns filter type.'});
    }

    const actionsFilter = (x: DatabaseActionType) => {
        return bansFilter(x) || warnsFilter(x);
    };

    //Run db cleaner
    const tsStart = Date.now();
    let playersRemoved = 0;
    try {
        playersRemoved = await playerDatabase.cleanDatabase('players', playersFilter);
    } catch (error) {
        return sendTypedResp({error: `<b>Failed to clean players with error:</b><br>${(error as Error).message}`});
    }

    let actionsRemoved = 0;
    try {
        actionsRemoved = await playerDatabase.cleanDatabase('actions', actionsFilter);
    } catch (error) {
        return sendTypedResp({error: `<b>Failed to clean actions with error:</b><br>${(error as Error).message}`});
    }

    //Return results
    const msElapsed = Date.now() - tsStart;
    return sendTypedResp({msElapsed, playersRemoved, actionsRemoved});
}


/**
 * Handle clean database request
 * @param {object} ctx
 */
async function handleRevokeWhitelists(ctx: Context) {
    //Typescript stuff
    const playerDatabase = (globals.playerDatabase as PlayerDatabase);
    type successResp = {
        msElapsed: number;
        cntRemoved: number;
    }
    const sendTypedResp = (data: successResp | GenericApiError) => ctx.send(data);

    //Sanity check
    if (typeof ctx.request.body.filter !== 'string') {
        return sendTypedResp({error: 'Invalid Request'});
    }
    const filterInput = ctx.request.body.filter;
    const daySecs = 86400;
    const currTs = now();

    let filterFunc: Function;
    if (filterInput === 'all') {
        filterFunc = (p: DatabasePlayerType) => true;
    } else if (filterInput === '30d') {
        filterFunc = (p: DatabasePlayerType) => p.tsLastConnection < (currTs - 30 * daySecs);
    } else if (filterInput === '15d') {
        filterFunc = (p: DatabasePlayerType) => p.tsLastConnection < (currTs - 15 * daySecs);
    } else if (filterInput === '7d') {
        filterFunc = (p: DatabasePlayerType) => p.tsLastConnection < (currTs - 7 * daySecs);
    } else {
        return sendTypedResp({error: 'Invalid whitelists filter type.'});
    }

    try {
        const tsStart = Date.now();
        const cntRemoved = playerDatabase.bulkRevokePlayerWhitelist(filterFunc);
        const msElapsed = Date.now() - tsStart;
        return sendTypedResp({msElapsed, cntRemoved});
    } catch (error) {
        return sendTypedResp({error: `<b>Failed to clean players with error:</b><br>${(error as Error).message}`});
    }
}
