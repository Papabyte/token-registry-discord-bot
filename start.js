const conf = require('ocore/conf.js');
const network = require('ocore/network.js');
const eventBus = require('ocore/event_bus.js');
const lightWallet = require('ocore/light_wallet.js');
const storage = require('ocore/storage.js');
const wallet_general = require('ocore/wallet_general.js');
const Discord = require('discord.js');
const moment = require('moment');

var discordClient = null;
const MIN_AMOUNT = 1e8; // constant from registry AA


lightWallet.setLightVendorHost(conf.hub);

eventBus.on('connected', function(ws){
	network.initWitnessesIfNecessary(ws, start);
});


eventBus.on('aa_response', function(objResponse){
	console.log('---------------------------------------------- aa_response ');
	if(objResponse.response.error)
		return console.log('ignored response with error: ' + objResponse.response.error);

	storage.readUnit(objResponse.trigger_unit, function(objTriggerUnit){
		if (!objTriggerUnit)
			throw Error('trigger unit not found ' + objResponse.trigger_unit);

		// we get data and amount in bytes sent to registry AA
		const data = getUnitData(objTriggerUnit);
		const byte_amount = getByteAmountToRegistryAA(objTriggerUnit);

		// we follow same logic as AA and treat the first case that is found true
		if (data.withdraw && data.amount && data.asset && data.symbol)
			return announceRemovedSupport(objResponse.trigger_address, data.amount, data.asset, data.symbol);

		if (data.description && typeof data.decimals !== 'undefined' && (data.asset || data.symbol) && byte_amount < MIN_AMOUNT){
			if (objResponse.response.responseVars && objResponse.response.responseVars['updated_support'])
				return announceDescription(objResponse.trigger_address, data.asset, data.symbol);
			else
				return console.log('ignored unchanged description');
		}

		if (data.move && data.address && data.asset && data.symbol)
			return console.log('ignored drawer move');

		if (byte_amount >= MIN_AMOUNT && data.asset && data.symbol){
			announceAddedSupport(objResponse.trigger_address, byte_amount, data.asset, data.symbol, data.drawer);
				// description may also have been set
			if (data.description && typeof data.decimals !== 'undefined')
				announceDescription(objResponse.trigger_address, data.asset, data.symbol);
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


async function announceDescription(author, asset, symbol){
	// we need first to find the linked symbol or the linked asset if it wasn't specified in data
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

	// we get the hash of the current description
	try { 
		const objStateVars = await getStateVarsForPrefix(conf.token_registry_aa_address, 'current_desc_' + asset);
		var desc_hash = objStateVars['current_desc_' + asset];
		console.log("found current_desc_: " + desc_hash);
	} catch(err){
		return console.log("Couldn't get state vars: " + err);
	}

	// from the description hash we find the description and the number of decimals
	getStateVarsForPrefixes(conf.token_registry_aa_address,['desc_' + desc_hash, 'decimals_' + desc_hash],
		function(err, objStateVars){
			if (err)
				return console.log("Couldn't get state vars: " + err);

			const description = objStateVars['desc_' + desc_hash];
			const decimal = objStateVars['decimals_' + desc_hash];

			const objEmbed = new Discord.MessageEmbed()
			.setColor('#0099ff')
			.setTitle(author + " changed description for " + symbol)
			.addFields(
				{ name: "Description", value: description, inline: true  },
				{ name: "Decimals", value: decimal, inline: true });
		
			sendToDiscord(objEmbed);
		}
	)
}


async function announceAddedSupport(author, amount, asset, symbol, drawer){

	const objRelationStates = await getStatesForRelation(asset, symbol);

	var lockTime = drawer ? " locked for " + drawer + " day" : "";
	if (drawer && drawer > 1)
		lockTime+="s";

	const objEmbed = new Discord.MessageEmbed()
	.setColor('#0099ff')
	.setTitle(author + " adds " + convertToGbString(amount) + " in support for " + symbol + lockTime)
	.addFields(
		{ name: "Supported asset", value: asset, inline: true  },
		{ name: "Total Stake", value: convertToGbString(objRelationStates.support || 0), inline: true },
		{ name: '\u200B', value: '\u200B' , inline: true }); // empty column to create a new row
	
	addRelationStatesInfo(objRelationStates, objEmbed, asset, symbol);

	sendToDiscord(objEmbed);

}

async function announceRemovedSupport(author, amount, asset, symbol){

	const objRelationStates = await getStatesForRelation(asset, symbol);

	const objEmbed = new Discord.MessageEmbed()
	.setColor('#0099ff')
	.setTitle(author + " removes " + convertToGbString(amount) + " from support for " + symbol)
	.addFields(
		{ name: "Unsupported asset", value: asset, inline: true  },
		{ name: "Total Stake", value: convertToGbString(objRelationStates.support || 0), inline: true },
		{ name: '\u200B', value: '\u200B' , inline: true 	}); // empty column to create a new row

	addRelationStatesInfo(objRelationStates, objEmbed, asset, symbol);

	sendToDiscord(objEmbed);
}

function addRelationStatesInfo(objRelationStates, objEmbed, asset, symbol){
	
	if (objRelationStates.competing_symbols.length){
		objEmbed.addFields(
			{ name: "Competing symbol", value: objRelationStates.competing_symbols.map(s => s.symbol), inline: true },
			{ name: "Stake", value: objRelationStates.competing_symbols.map(s => convertToGbString(s.amount)), inline: true },
			{ name: '\u200B', value: '\u200B' ,	 inline: true } // empty column to create a new row
		)
	}
	if (objRelationStates.competing_assets.length){
		objEmbed.addFields(
			{ name: "Competing asset", value: objRelationStates.competing_assets.map(a => a.asset), inline: true },
			{ name: "Stake", value: objRelationStates.competing_assets.map(a => convertToGbString(a.amount)), inline: true },
			{ name: '\u200B', value: '\u200B' ,	 inline: true } // empty column to create a new row
		)
	}

	var footer = "";

	if (objRelationStates.s2a)
		footer += "Symbol `" + symbol + "` is attributed to asset " + objRelationStates.s2a + "\n";

	if (objRelationStates.asset_expiry){
		let expiryMoment = moment.unix(objRelationStates.asset_expiry);
		if (expiryMoment.isAfter(moment()))
		footer += "Asset dispute period expires " + moment().to(expiryMoment) + "\n";
	}

	if (objRelationStates.symbol_expiry){
		let expiryMoment = moment.unix(objRelationStates.symbol_expiry);
		if (expiryMoment.isAfter(moment()))
		footer += "Symbol dispute period expires " + moment().to(expiryMoment) + "\n";
	}

	if (objRelationStates.grace_expiry){
		let expiryMoment = moment.unix(objRelationStates.grace_expiry);
		if (expiryMoment.isAfter(moment()))
		footer += "Asset grace period expires " + moment().to(expiryMoment) + "\n";
	}
	if (footer.length)
		objEmbed.setFooter(footer)
}


function getStatesForRelation(asset, symbol){
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
				const objRelationStates = { 
					competing_symbols: [],
					competing_assets: [],
				};

				for (var key in objStateVars){
					if (key.indexOf('support_' + symbol) === 0){
						if (key.slice(-44) !== asset)
							objRelationStates.competing_assets.push({asset: key.slice(-44), amount: objStateVars[key]});
						else
							objRelationStates.support = objStateVars[key];
						continue;
					}
					if (key.indexOf('support_') === 0 && key.slice(-44) === asset){
						if (key.slice(8,-44) !== symbol)
							objRelationStates.competing_symbols.push({symbol: key.slice(8,-45), amount: objStateVars[key]});
						continue;
					}
					if (key === 's2a_' + symbol){
						objRelationStates.s2a = objStateVars[key];
						continue;
					}
					if (key === 'expiry_ts_' + asset){
						objRelationStates.asset_expiry = objStateVars[key];
						continue;
					}
					if (key === 'expiry_ts_' + symbol){
						objRelationStates.symbol_expiry = objStateVars[key];
						continue;
					}
					if (key === 'grace_expiry_ts_' + asset){
						objRelationStates.grace_expiry = objStateVars[key];
						continue;
					}
				}
				objRelationStates.competing_assets.sort((a,b) => b.amount - a.amount);
				objRelationStates.competing_symbols.sort((a,b) => b.amount - a.amount);

				return resolve(objRelationStates);
		});
	});
}

function convertToGbString (amount){
	return (amount/1e9 >=1 ? ((amount/1e9).toPrecision(6)/1).toLocaleString(): ((amount/1e9).toPrecision(6)/1)) + ' GB'
}



async function start(){
	await initDiscord();
	wallet_general.addWatchedAddress(conf.token_registry_aa_address, function(error){
		if (error)
			console.log(error)
		else
			console.log(conf.token_registry_aa_address + " added as watched address")

	});
	setInterval(lightWallet.refreshLightClientHistory, 60*1000);
}


async function initDiscord(){
	if (!conf.discord_token)
		throw Error("discord_token missing in conf");
	if (!conf.discord_channels || !conf.discord_channels.length)
		throw Error("channels missing in conf");
	discordClient = new Discord.Client();
	discordClient.on('ready', () => {
		console.log(`Logged in Discord as ${discordClient.user.tag}!`);
	});
	discordClient.on('error', (error) => {
		console.log(`Discord error: ${error}`);
	});
	await discordClient.login(conf.discord_token);
}
	

function sendToDiscord(to_be_sent){
	if (!discordClient)
		return console.log("discord client not initialized");
	conf.discord_channels.forEach(function(channelId){
			discordClient.channels.fetch(channelId).then(function(channel){
				channel.send(to_be_sent);
			});
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


process.on('unhandledRejection', up => { throw up });