import koa from 'koa'
import koaRouter from 'koa-router'
const { bodyParser } = require("@koa/bodyparser");
import JSONbig from 'json-bigint'
import serve from 'koa-static'
import { join } from 'path';
import {setUrl} from '@/action/setUrl.js'
import {login, reconnection} from '@/action/login.js'
import {cacheAllContact} from '@/action/contact'
import {setCached} from '@/action/common'
import {CheckOnline} from '@/api/login'
import { getLocalIPAddress, compareMemberLists, getAttributesFromXML } from "@/utils/index.js";
import {Message} from '@/class/MESSAGE.js'
import {Contact} from '@/class/CONTACT.js'
import {Room} from '@/class/ROOM.js'
import { botEmitter, roomEmitter } from '@/bot.js'
import {ds, getAppId} from '@/utils/auth.js';
import {db} from '@/sql/index.js'
import {MessageType} from '@/type/MessageType'
import {RoomInvitation} from '@/class/ROOMINVITATION.js'
import {getRoomLiveInfo} from '@/action/room.js'
import { Friendship } from '@/class/FRIENDSHIP';
import { getMyInfo } from '@/action/personal'
export const bot = botEmitter
export let staticUrl = 'static'
export let proxyUrl = ''
const ip = getLocalIPAddress()
const app = new koa()
const router = new koaRouter()
// 使用 bodyParser 解析 POST 请求的 body

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.use(bodyParser());


export const startServe = (option) => {
  // 启动服务
  var cbip = option.ip || ip;
  let callBackUrl = `http://${cbip}:${option.port}${option.route}`
  if(option.proxy){
    callBackUrl = `${option.proxy}${option.route}`
  }
  proxyUrl = option.proxy
  // 设置文件保存目录
  app.use(serve(join(process.cwd(), option.static)))
  staticUrl = join(process.cwd(), option.static)


  // 定义一个接口，能够同时处理 GET 和 POST 请求
  router.post(option.route, async (ctx) => {
    try{
      const body = JSONbig({ storeAsString: true }).parse(ctx.request.rawBody); // 获取 POST 请求的 body 数据
      if(option.debug){
        console.log(body);
      }
      // 兼容新版本 key 值变化
      body.Appid = body.Appid || body.appid
      body.TypeName = body.TypeName || body.type_name
      body.Data = body.Data || body.data

      // all 事件
      bot.emit('all', body)

      if(body && body.TypeName === 'Offline'){
        console.log('断线重连中...')
        const s = await reconnection()
        if(s){
          console.log('断线重连成功')
        }else{
          console.log('断线重连失败,请重新登录！')
          let loginRes = await loopLogin()
          if (loginRes) {
            botEmitter.emit('login', {
              content: '登录成功'
            })
          }
        }
      }

      // 判断是否是微信消息
      if(body.Appid && body.TypeName === 'AddMsg'){ // 大部分消息类型都为 AddMsg
        // 消息hanlder
        const msg = new Message(body)
        // 企业消息将联系人存入数据库
        if (msg.fromId?.includes('@openim')) {
          db.insertContact({
            nickName: msg._pushContent.split(':')[0].slice(0, -1),
            userName: msg.fromId,
            smallHeadImgUrl: 'https://raw.githubusercontent.com/finalpi/wechat2tg/wx2tg-pad/qywx.jpg',
            bigHeadImgUrl: 'https://raw.githubusercontent.com/finalpi/wechat2tg/wx2tg-pad/qywx.jpg',
          })
        }
        // 发送消息
        const type = msg.type()
        if(type === MessageType.RoomInvitation){ // 群邀请
          let obj = Message.getXmlToJson(msg.text())
          obj.fromId = msg.fromId
          bot.emit(`room-invite`, new RoomInvitation(obj))
        }else if(type === MessageType.AddFriend){ // 好友请求
          let obj = getAttributesFromXML(msg.text())
          bot.emit('friendship', new Friendship(obj))
        }else{
          if (type === MessageType.Quote) {
            let obj = Message.getXmlToJson(msg.text())
            msg._text = obj.msg.appmsg.title
            msg.refer = obj.msg.appmsg.refermsg
          }
          if (type === MessageType.Emoji) {
            let obj = Message.getXmlToJson(msg.text())
            msg.emoji = obj.msg.emoji
          }
          bot.emit('message', msg)
        }
      }else if(body && body.TypeName === 'ModContacts'){ // 好友消息， 群信息变更
        // 消息hanlder
        const id = body.Data?.UserName?.string||''
        if(id.endsWith('@chatroom')&& body.Data?.ImgFlag!=1){ // 群消息
          const oldInfo = db.findOneByChatroomId(id)
          const newInfo = await getRoomLiveInfo(id)
          // 比较成员列表
          const obj = compareMemberLists(oldInfo.memberList, newInfo.memberList)
          if(obj.added.length > 0){
            obj.added.map((item) => {
              const member = new Contact(item)
              roomEmitter.emit(`join:${id}`, new Room(newInfo), member, member.inviterUserName)
            })
          }
          if(obj.removed.length > 0){
            obj.removed.map((item) => {
              const member = new Contact(item)
              roomEmitter.emit(`leave:${id}`, new Room(newInfo), member)
            })
          }

          if(body.Data.NickName.string !== oldInfo.nickName){ // 群名称变动
            roomEmitter.emit(`topic:${id}`, new Room(newInfo), body.Data.NickName.string, oldInfo.nickName)
          }
          db.updateRoom(id, newInfo)
        }
      }else{
        bot.emit('other', body)
      }

      // "TypeName": "ModContacts", 好友消息， 群信息变更
      // "TypeName": "DelContacts" 删除好友
      // "TypeName": "DelContacts" 退出群聊

    }catch(e){
      console.error(e)
    }
    ctx.body = "SUCCESS";
  }).get(option.route, (ctx) => {
    const query = ctx.request.query; // 获取 GET 请求的 query 参数
    console.log('GET 请求的数据:', query);
    ctx.body = "SUCCESS";
  });

  // app.use(bodyParser());


  async function loopLogin() {
    let loginRes = await login()
    while (!loginRes) {
      console.log('登录失败,5s 后重试')
      await new Promise(resolve => setTimeout(resolve, 5000))
      loginRes = await login()
    }
    return loginRes
  }

  return new Promise((resolve, reject) => {
    app.listen(option.port, async (err) => {
      if(err){
        reject(err)
        process.exit(1);
      }

      try{
        let isOnline = ''
        if(getAppId()){ // 有appid时
          isOnline = await CheckOnline({
            appId: getAppId()
          })
        }else{
          console.log('未设置appid，启动登录')
          isOnline = {ret: 200, data: false}
        }

        if(isOnline.ret === 200 && isOnline.data === false){
          console.log('未登录')
          await loopLogin();
        }
        setCached(true)
        let myInfo = await getMyInfo()
        const dbName = option.db_path + myInfo.wxid + '.db'
        if (!dbName) {
          // 说明未登录 跳转登录
          ds.appid = ''
          ds.token = ''
          ds.save()
          await loopLogin();
        }
        if(!db.exists(dbName)){
          console.log('创建本地数据库，启用缓存')
          db.connect(dbName)
          // 创建表
          db.createContactTable()
          db.createRoomTable()
          // 缓存所有联系人 并保存到本地数据库
          console.log('本地数据初始化，可能需要耗费点时间，耐心等待...')
          await delay(1000) // 防止异步
          await cacheAllContact()
          console.log('数据初始化完毕')
        }else{
          db.connect(dbName)
          console.log('存在缓存数据，启用缓存')
        }

        // 此时再启用回调地址 防止插入数据时回调
        app.use(router.routes())
        app.use(router.allowedMethods())

        const res = await setUrl(callBackUrl)

        if(res.ret === 200){
          console.log(`设置回调地址为：${callBackUrl}`)
          console.log('服务启动成功')
          resolve({app, router})
        }else{
          if (!res.msg) {
            // 删除ds文件
            ds.appid = ''
            ds.token = ''
            ds.save()
          }
          console.log('回调地址设置失败，请确定gewechat能访问到回调地址网络: ', callBackUrl)
          reject(res)
          process.exit(1);
        }
      }catch(e){
        console.log('服务启动失败')
        console.error(e)
        reject(e)
        process.exit(1);
      }
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(`Port ${option.port} is already in use. Please use a different port.`);
      } else {
        reject(`Server error: ${err}`);
      }
    });
  })
}
