import EventEmitter from './class/EMITTER.js'

export const botEmitter = new EventEmitter()

botEmitter.setEventNames(['message', 'all', 'room-invite', 'friendship', 'scan', 'login'])

export const roomEmitter = new EventEmitter()


