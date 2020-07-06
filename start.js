const conf = require('ocore/conf.js');
const myWitnesses = require('ocore/my_witnesses.js');
const network = require('ocore/network.js');
const eventBus = require('ocore/event_bus.js');
const lightWallet = require('ocore/light_wallet.js');
const storage = require('ocore/storage.js');
const wallet_general = require('ocore/wallet_general.js');
const Discord = require('discord.js');
const discordChannels = process.env.testnet ? ["729547841801814157", "729169652030374030"] : []; // 729547841801814157 // 729169652030374030
const moment = require('moment');

var discordClient = null;
const MIN_AMOUNT = 1e8;

myWitnesses.readMyWitnesses(function (arrWitnesses) {
	if (arrWitnesses.length > 0)
		return start();
	myWitnesses.insertWitnesses(conf.initial_witnesses, start);
}, 'ignore');



eventBus.on('aa_response', function(objResponse){
	console.log('---------------------------------------------- aa_response ');
	if(objResponse.response.error)
		return console.log('ignored response with error: ' + objResponse.response.error);

	storage.readUnit(objResponse.trigger_unit, function(objTriggerUnit){
		if (!objTriggerUnit)
			throw Error('trigger unit not found ' + objResponse.trigger_unit);

		const data = getUnitData(objTriggerUnit);
		const byte_amount = getByteAmountToRegistryAA(objTriggerUnit);

		if (data.withdraw && data.amount && data.asset && data.symbol)
			return announceRemovedSupport(objResponse.trigger_address, data.amount, data.asset, data.symbol);

		if (data.description && typeof data.decimals !== 'undefined' && (data.asset || data.symbol) && byte_amount < MIN_AMOUNT){
			console.log(objResponse);
			if (objResponse.response.responseVars && objResponse.response.responseVars['updated_support'])
				return announceChangedDescription(objResponse.trigger_address, data.asset, data.symbol);
			else
				return console.log('ignored unchanged description');
		}

		if (data.move && data.address && data.asset && data.symbol)
			return console.log('ignored drawer move');

		if (byte_amount >= MIN_AMOUNT && data.asset && data.symbol){
			announceAddedSupport(objResponse.trigger_address, byte_amount, data.asset, data.symbol, data.drawer);

			if (data.description && typeof data.decimals !== 'undefined')
				announceChangedDescription(objResponse.trigger_address, data.asset, data.symbol);
				return;
		}
		return console.log('no case for: ' +  byte_amount +  ' ' + JSON.stringify(data))
	});

});


function getByteAmountToRegistryAA(objTriggerUnit){
	let amount = 0;
	objTriggerUnit.messages.forEach(function (message){
		if (message.app !== 'payment')
			return;
		const payload = message.payload;
		if (payload.asset)
			return;
		payload.outputs.forEach(function (output){
			if (output.address === conf.token_registry_aa_address) {
				amount += output.amount; // in case there are several outputs
			}
		});
	});
	return amount;
}

function getUnitData(objTriggerUnit){
		for (var i=0; i < objTriggerUnit.messages.length; i++)
		if (objTriggerUnit.messages[i].app === 'data') // AA considers only the first data message
			return objTriggerUnit.messages[i].payload;
		return {};
}


async function announceChangedDescription(author, asset, symbol){

	if (!symbol)
		try {
			const objStateVars = await getStateVarsForPrefix(conf.token_registry_aa_address, 'a2s_' + asset);
			symbol = objStateVars['a2s_' + asset];
			console.log("found symbol: " + symbol);
		} catch(err){
			return console.log("Couldn't get state vars: " + err);
		}
	if (!asset)
		try {
			const objStateVars = await  getStateVarsForPrefix(conf.token_registry_aa_address, 's2a_' + symbol)
			asset = objStateVars['s2a_' + symbol];
			console.log("found asset: " + asset);
		} catch(err){
			return console.log("Couldn't get state vars: " + err);
		}

		try {
			const objStateVars = await getStateVarsForPrefix(conf.token_registry_aa_address, 'current_desc_' + asset);
			var desc_hash = objStateVars['current_desc_' + asset];
			console.log("found current_desc_: " + desc_hash);
		} catch(err){
			return console.log("Couldn't get state vars: " + err);
		}

		getStateVarsForPrefixes(conf.token_registry_aa_address,['desc_' + desc_hash, 'decimals_' + desc_hash],
			function(err, objStateVars){
				if (err)
					return console.log("Couldn't get state vars: " + err);

				const description = objStateVars['desc_' + desc_hash];
				const decimal = objStateVars['decimals_' + desc_hash];

				var announcement = author + " changed description for  `" + symbol + "`\n" + "Description: `" + description+ "`\nDecimals:`" + decimal+ "`\n";
				console.log(announcement);
				sendToDiscord(announcement);
				
			})


	}




async function announceAddedSupport(author, amount, asset, symbol, drawer){
	var lockTime = drawer ? " locked for " + drawer + " day" : "";
	if (drawer && drawer > 1)
		lockTime+="s";
	var announcement = author + " adds " + convertToGbString(amount) + " to supporting symbol `" + symbol + "` for `" + asset+ "`" + lockTime +"\n";
	announcement += await getNewRelationStateAnnouncement(asset, symbol);
	sendToDiscord(announcement);
}

async function announceRemovedSupport(author, amount, asset, symbol){
	var announcement = author + " withdraws " + convertToGbString(amount) + " from supporting symbol `" + symbol + "` for `" + asset + "`\n";
	announcement += await getNewRelationStateAnnouncement(asset, symbol);
	sendToDiscord(announcement);
}

async function getNewRelationStateAnnouncement(asset, symbol){
	const objRelationState = await getNewStateForRelation(asset, symbol);
	console.log(objRelationState);
	var announcement = "";
	announcement += "Support for attributing symbol `" + symbol + "` to `" + asset +"`: " + convertToGbString(objRelationState.support || 0) + "\n";
	if (objRelationState.s2a)
		announcement += "Symbol is `" + symbol + "` attributed to asset : `" + objRelationState.s2a + "`\n";

	if (objRelationState.competing_symbols.length){
		announcement += "Competing symbols: \n";
		objRelationState.competing_symbols.forEach(function (competing_symbol){
			announcement += "`" + competing_symbol.symbol + "`: " + convertToGbString(competing_symbol.amount) + "\n";
		});
	}

	if (objRelationState.competing_assets.length){
		announcement += "Competing assets: \n";
		objRelationState.competing_assets.forEach(function (competing_asset){
			announcement += "`" + competing_asset.asset + "`: "+ convertToGbString(competing_asset.amount) + "\n";
		});
	}

	if (objRelationState.asset_expiry){
		let expiryMoment = moment.unix(objRelationState.asset_expiry);
		if (expiryMoment.isAfter(moment()))
			announcement += "Asset dispute period expires " + moment().to(expiryMoment) + "\n";
	}

	if (objRelationState.symbol_expiry){
		let expiryMoment = moment.unix(objRelationState.symbol_expiry);
		if (expiryMoment.isAfter(moment()))
			announcement += "Symbol dispute period expires " + moment().to(expiryMoment) + "\n";
	}

	if (objRelationState.grace_expiry){
		let expiryMoment = moment.unix(objRelationState.grace_expiry);
		if (expiryMoment.isAfter(moment()))
			announcement += "Asset grace period expires " + moment().to(expiryMoment) + "\n";
	}
	return announcement;
}


function getNewStateForRelation(asset, symbol){
	return new Promise(function(resolve){
		getStateVarsForPrefixes(conf.token_registry_aa_address,
			[
				'support_',
				's2a_' + symbol,
				'expiry_ts_' + asset,
				'expiry_ts_' + symbol,
				'grace_expiry_ts_'+ asset,
			], 
			function(err, objStateVars){
				if (err){
					console.log("Couldn't get state vars: " + err);
					return resolve(null);
				}
				const objRelationState = { 
					competing_symbols: [],
					competing_assets: [],
				};

				for (var key in objStateVars){
					if (key.indexOf('support_' + symbol) === 0){
						if (key.slice(-44) !== asset)
							objRelationState.competing_assets.push({asset: key.slice(-44), amount: objStateVars[key]});
						else
							objRelationState.support = objStateVars[key];
						continue;
					}
					if (key.indexOf('support_') === 0 && key.slice(-44) === asset){
						if (key.slice(8,-44) !== symbol)
							objRelationState.competing_symbols.push({symbol: key.slice(8,-45), amount: objStateVars[key]});
						continue;
					}
					if (key === 's2a_' + symbol){
						objRelationState.s2a = objStateVars[key];
						continue;
					}
					if (key === 'expiry_ts_' + asset){
						objRelationState.asset_expiry = objStateVars[key];
						continue;
					}
					if (key === 'expiry_ts_' + symbol){
						objRelationState.symbol_expiry = objStateVars[key];
						continue;
					}
					if (key === 'grace_expiry_ts_' + asset){
						objRelationState.grace_expiry = objStateVars[key];
						continue;
					}
				}
				objRelationState.competing_assets.sort((a,b) => b.amount - a.amount);
				objRelationState.competing_symbols.sort((a,b) => b.amount - a.amount);

				return resolve(objRelationState);
		});
	});
}

function convertToGbString (amount){
	return (amount/1e9 >=1 ? ((amount/1e9).toPrecision(6)/1).toLocaleString(): ((amount/1e9).toPrecision(6)/1)) + ' GB'
}

eventBus.on('connected', function(){
//	network.addLightWatchedAa(conf.token_registry_aa_address);

	wallet_general.addWatchedAddress(conf.token_registry_aa_address, function(error){
		if (error)
			console.log(error)
		else
			console.log(conf.token_registry_aa_address + " added as watched address")

	});
});


async function start(){
	lightWallet.setLightVendorHost(conf.hub);
	setInterval(lightWallet.refreshLightClientHistory, 60*1000);

	await initDiscord();
}


async function initDiscord(){
	if (!conf.discord_token)
		throw Error("discord_token missing in conf");
	discordClient = new Discord.Client();
	discordClient.on('ready', () => {
		console.log(`Logged in Discord as ${discordClient.user.tag}!`);
	});
	discordClient.on('error', (error) => {
		console.log(`Discord error: ${error}`);
	});
	await discordClient.login(conf.discord_token);
}
	

function sendToDiscord(text){
	if (!discordClient)
		return console.log("discord client not initialized");
	discordChannels.forEach(function(channel){
		try {
			discordClient.channels.get(channel).send(text);
		} catch(e) {
			console.log("couldn't get channel " + channel + ", reason: " + e);
		}
	});
}


function getStateVarsForPrefixes(aa_address, arrPrefixes, handle){
	Promise.all(arrPrefixes.map((prefix)=>{
		return getStateVarsForPrefix(aa_address, prefix)
	})).then((arrResults)=>{
		return handle(null, Object.assign({}, ...arrResults));
	}).catch((error)=>{
		return handle(error);
	});
}

function getStateVarsForPrefix(aa_address, prefix, start = '0', end = 'z', firstCall = true){
	return new Promise(function(resolve, reject){
		if (firstCall)
			prefix = prefix.slice(0, -1);
		const CHUNK_SIZE = 2000; // server wouldn't accept higher chunk size

		if (start === end)
			return getStateVarsForPrefix(aa_address, prefix + start,  '0', 'z').then(resolve).catch(reject); // we append prefix to split further

		network.requestFromLightVendor('light/get_aa_state_vars', {
			address: aa_address,
			var_prefix_from: prefix + start,
			var_prefix_to: prefix + end,
			limit: CHUNK_SIZE
		}, function(ws, request, objResponse){
			if (objResponse.error)
				return reject(objResponse.error);

			if (Object.keys(objResponse).length >= CHUNK_SIZE){ // we reached the limit, let's split in two ranges and try again
				const delimiter =  Math.floor((end.charCodeAt(0) - start.charCodeAt(0)) / 2 + start.charCodeAt(0));
				Promise.all([
					getStateVarsForPrefix(aa_address, prefix, start, String.fromCharCode(delimiter), false),
					getStateVarsForPrefix(aa_address, prefix, String.fromCharCode(delimiter +1), end, false)
				]).then(function(results){
					return resolve({...results[0], ...results[1]});
				}).catch(function(error){
					return reject(error);
				})
			} else{
				return resolve(objResponse);
			}

		});
	});
}
