﻿let logger = require('../util/logger').getLogger();
let pomeloClient = require('../net/pomelo-client');
let utils = require('../util/utils');
let lodash = require('lodash');
let UserData = require('../dataMgr/userData');
let RobotCfg = require('../common/robotCfg');
let Game15 = require('./game15');

const C_HOST =  '127.0.0.1';
// const C_HOST =  '47.99.50.101';
const C_PORT = 8686;

class Client{
    constructor(openid, invateCode, index){
		let clubId = Number(String(invateCode).substring(0, 3));
        this.host = C_HOST;
        this.port = C_PORT;      
        this.code = openid;
		this.openid = openid;
		this.clubId = clubId;
		this.invateCode = invateCode;
		this.index = index;
        this.mainLoop();
    }

    reset(){
		if (this.pomelo) {
			this.pomelo.disconnect();
			this.pomelo = null; 
		}
        this.loginData = null; 
		this.userData = null;
		this.gameId = null;
		this.tableId = null;
		this.robotCfg = null;
    }
    
    async mainLoop(){
		this.reset();
		
		// 登入大厅
        await this.createConnect();
        this.userData = new UserData();
        this.userData.init(this.pomelo, this.loginData);
		await utils.sleep(1000);
		
		// 进入俱乐部
		await this.enterClub();
    }
    
    async createConnect(){
        let ok = false;
        while(true){
            let pomelo = new pomeloClient();
            let r = await pomelo.init({ host: C_HOST, port: C_PORT, log: true, code:this.code } ).then( ()=>{
                // 获取逻辑服 地址
                return  pomelo.request("gate.gateHandler.queryEntry", { code: this.code });
            }).then((data)=>{
                if (data.code == 202) {
                    this._handleMaintainState();
                    throw '服务器维护中';
                }
                this.host = data.host;
                this.port = data.port;
                return pomelo.disconnect();    
            }).then(()=>{
                //connenct 逻辑服
                pomelo = new pomeloClient();
                return pomelo.init({ host: this.host, port: this.port, log: true, code:this.code } ) ;
            }).then(()=>{
				//login
				let userInfo = this._getUserInfo();
				if (!userInfo) {
					this._onLoginFailed();
                    throw 'robot config no exist.';
				}
                return pomelo.request("connector.entryHandler.enter",
                                        {
                                            code: this.code,
                                            userInfo: userInfo,
                                            platform: 'WIN'
                                        });
            }).then( async(data)=>{     
                if (data.code == 201) {
                    console.log("重连 host:%s port:%s", data.host, data.port);
                    // 重定向
                    await pomelo.disconnect();  
                    throw '重新登入';  
                }
                else if (data.code == 200) {
                    console.log("连接逻辑服成功 info: ", data.info);
                    this.loginData = data.info;
                    this.pomelo = pomelo;                 
                    ok = true;                  
                }
                else if (data.code == 202) {
                    this._handleMaintainState();
                    throw null;
                }
                else {
                    this._onLoginFailed();
                    throw null;
                }                                                                                 
            }).catch((err)=>{
                logger.error(this.code+":createConnect err:"+err);
            });

            if( ok ){
                break;
            }else{
                await utils.sleep(3*1000);
            }
        }
    }

    _getUserInfo(){
		let robotInfos = RobotCfg[this.clubId];
		let info = null;
		if (robotInfos && robotInfos[this.index-1]) {
			let robotData = robotInfos[this.index-1];
			this.robotCfg = robotData;
			info = {
				name: robotData.name,
				gender: robotData.gender,
				avatarUrl: robotData.avatarUrl
			}
		}
        return info;
    }

    _onLoginFailed(){
		logger.info('------------enter _onLoginFailed');
    }

    _handleMaintainState(){
        logger.info('------------enter _handleMaintainState');
    }

    async enterClub() {
        this.pomelo.request('connector.clubHandler.enterClub', {clubId: this.clubId}).then((data)=>{
			if (data.code == 0) {
				// 进入成功
				this.findTable()
			} else if(data.code == 6) {
				// 玩家不在俱乐部
				this.pomelo.request('connector.clubHandler.joinClubByCode', {invateCode: this.invateCode}).then((data)=>{
					if (data.code != 0) {
						logger.error('join club error:', data);
						this.pomelo.disconnect();
						return;
					}
					this.findTable()
				});
			} else{
				logger.error('enter club error:', data);
				this.pomelo.disconnect();
				return;
			}
		});
    }
	
	async findTable() {
		// TODO:暂时简单处理，随机延时加入
		let time = utils.randomInt(2000, 15 * 1000);
        await utils.sleep(time);
        
        // 是否已经在牌桌里了
        let gameInfo = this.loginData.gameInfo;
        if (gameInfo.code == 1) {
            let info = gameInfo.gameInfo;
            logger.info('%s已经在牌桌. gameInfo = %o', this.code, info);
            this.gameId = info.gameId;
            this.tableId = info.tableId;
            if(!this.enterTable(info.host, info.port)){
                logger.error('已经在牌桌加入失败.');
            }
            return;
        }

		let ok = false;
        while(true) {
			// 获取现有桌子
			await this.pomelo.request('connector.clubHandler.getClubTable', {clubId: this.clubId}).then((data)=> {
				if (data.code != 0) {
					throw '获取俱乐部已创桌子失败!';
				}
               
				let tableInfos = data.tableInfos;
				let tempTables = [];
				let playwayId = this.robotCfg.playwayId;
				for (let i = 0; i < tableInfos.length; i++) {
					const table = tableInfos[i];
					if ((playwayId == 0 || playwayId == table.playwayId) && table.players.length < table.chairCount) {
						tempTables.push(table);
					}
				}

				if (tempTables.length > 0) {
					let randTable = lodash.sample(tempTables);
					logger.info('加入桌子 table = ', randTable);
					this.gameId = randTable.gameId;
					this.tableId = randTable.tableId;
					return randTable;
				}

				// 创建桌子，获取玩法
				let gameMode = this.robotCfg.gameMode;
				let gameId = this.robotCfg.gameId;
				return this.pomelo.request('connector.clubHandler.getClubPlayway', {clubId: this.clubId, gameMode: gameMode, gameId: gameId});
			}).then((data)=> {
				if (data.tableId) {
					// 加入桌子
					return data;
				} else {
					// 创建桌子
					if (data.code != 0) {
						throw '获取俱乐部玩法失败!';
					}
					let playways = data.playways;
					if (playways.length <= 0) {
						logger.info('俱乐部[%d]还没有设置玩法.', this.clubId);
						throw '请先设置俱乐部玩法.'
					}

					let tempPlayway = [];
					let playwayId = this.robotCfg.playwayId;
					for (let i = 0; i < playways.length; i++) {
						const playway = playways[i];
						if (playwayId == 0 || playwayId == playway.id) {
							tempPlayway.push(playway);
						}
					}

					if (tempPlayway.length > 0) {
						let randPlayway = lodash.sample(tempPlayway);
						this.gameId = randPlayway.gameId;
						this.playwayId = randPlayway.id;
						logger.info('创建桌子 table = ', randPlayway);
						return this.pomelo.request('connector.lobbyHandler.getGameServerInfo', {gameId: randPlayway.gameId});
					}

					logger.warn('俱乐部[%d]不存在玩法[%s].', this.clubId, playwayId);
					throw '请先设置对应玩法.'
				}
			}).then((data)=>{
				this.host = data.host;
                this.port = data.port;
                return this.enterTable(this.host, this.port);
            }).then((data)=>{
                ok = data
                logger.info('是否找到桌子 = ', ok);
            }).catch((err)=>{
				logger.warn(err);
			})

			if( ok ){
                break;
            }else{
                logger.info('重新循环查找桌子')
                await utils.sleep(3*1000);
                this.pomelo.disconnect();
                await this.createConnect();
            }
		}
    }
    
    async enterTable(host, port) {
        let ok = false;
        this.pomelo.disconnect();
        this.pomelo = new pomeloClient();
        await this.pomelo.init({ host: host, port: port, log: true, code:this.code }).then(()=>{
            // 先注册游戏协议
            this.enterGame(this.gameId);

            let msg = {
                openid: this.openid,
                clubId: this.clubId,
                playwayId: this.playwayId || '',
                tableId: this.tableId || 0,
            }
            return this.pomelo.request("table.entryHandler.enter", msg );
        }).then((data)=>{
            if (data.code == 0) {
                logger.info('%s加入牌桌成功.', this.code);
                ok = true;
            } else{
                logger.warn('%s加入牌桌失败. data = %o', this.code, data);
                ok = false;
            }
        }).catch((err)=>{
            logger.error(this.code+":enterTable err:"+err);
        });

        return ok;
    }

    async enterGame(gameId) {
		gameId = Number(gameId);
        switch(gameId){
            case 15:
                let game15 = new Game15(this);  //是否会内存泄漏?
                await game15.init();
                break;
            default:
                logger.warn('no exist switch gameId[%d].', gameId);
                this.pomelo.disconnect();
        }
    }
};

module.exports = Client;