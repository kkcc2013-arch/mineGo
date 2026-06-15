/**
 * 推送通知服务单元测试
 * REQ-00136: FCM/APNs 移动推送通知系统
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { PushNotificationService, getPushNotificationService } = require('../../shared/pushNotificationService');
const { getClient } = require('../../shared/db');
const { getRedisClient } = require('../../shared/redis');

// Mock Firebase Admin
const mockFirebaseAdmin = {
    initializeApp: sinon.stub().returns({}),
    messaging: sinon.stub().returns({
        send: sinon.stub().resolves('mock-message-id')
    }),
    credential: {
        cert: sinon.stub().returns({})
    }
};

// Mock database client
const mockClient = {
    query: sinon.stub(),
    release: sinon.stub()
};

const mockRedis = {
    zadd: sinon.stub().resolves(),
    zrangebyscore: sinon.stub().resolves([]),
    zrem: sinon.stub().resolves()
};

describe('PushNotificationService', () => {
    let pushService;

    beforeEach(() => {
        pushService = new PushNotificationService();
        sinon.stub(getClient, 'call').resolves(mockClient);
        sinon.stub(getRedisClient, 'call').returns(mockRedis);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('initialize', () => {
        it('should initialize successfully with valid credentials', async () => {
            process.env.FIREBASE_PROJECT_ID = 'test-project';
            process.env.FIREBASE_CLIENT_EMAIL = 'test@test.com';
            process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';

            await pushService.initialize();

            expect(pushService.initialized).to.be.true;
        });

        it('should handle missing credentials gracefully', async () => {
            delete process.env.FIREBASE_PROJECT_ID;
            delete process.env.FIREBASE_CLIENT_EMAIL;
            delete process.env.FIREBASE_PRIVATE_KEY;

            await pushService.initialize();

            expect(pushService.initialized).to.be.false;
        });
    });

    describe('isQuietHours', () => {
        it('should return false when no quiet hours configured', () => {
            const preferences = { quiet_hours_start: null, quiet_hours_end: null };
            const result = pushService.isQuietHours(preferences);
            expect(result).to.be.false;
        });

        it('should return true during quiet hours', () => {
            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const currentTime = currentHour * 60 + currentMinute;

            // 设置当前时间前后的静默时段
            const startMinutes = currentTime - 30;
            const endMinutes = currentTime + 30;
            const startHour = Math.floor(startMinutes / 60) % 24;
            const startMin = startMinutes % 60;
            const endHour = Math.floor(endMinutes / 60) % 24;
            const endMin = endMinutes % 60;

            const preferences = {
                quiet_hours_start: `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`,
                quiet_hours_end: `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`,
                timezone: 'UTC'
            };

            const result = pushService.isQuietHours(preferences);
            expect(result).to.be.true;
        });

        it('should return false outside quiet hours', () => {
            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const currentTime = currentHour * 60 + currentMinute;

            // 设置当前时间之外的静默时段
            const startMinutes = (currentTime + 120) % 1440;
            const endMinutes = (currentTime + 180) % 1440;
            const startHour = Math.floor(startMinutes / 60) % 24;
            const startMin = startMinutes % 60;
            const endHour = Math.floor(endMinutes / 60) % 24;
            const endMin = endMinutes % 60;

            const preferences = {
                quiet_hours_start: `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`,
                quiet_hours_end: `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`,
                timezone: 'UTC'
            };

            const result = pushService.isQuietHours(preferences);
            expect(result).to.be.false;
        });
    });

    describe('isTypeEnabled', () => {
        it('should return true for enabled notification type', () => {
            const preferences = {
                pokemon_catch: true,
                gym_battle: true
            };

            expect(pushService.isTypeEnabled(preferences, 'pokemon_catch')).to.be.true;
            expect(pushService.isTypeEnabled(preferences, 'gym_battle')).to.be.true;
        });

        it('should return false for disabled notification type', () => {
            const preferences = {
                marketing: false
            };

            expect(pushService.isTypeEnabled(preferences, 'marketing')).to.be.false;
        });

        it('should return true for unknown notification type', () => {
            const preferences = {};
            expect(pushService.isTypeEnabled(preferences, 'unknown_type')).to.be.true;
        });
    });

    describe('getChannelId', () => {
        it('should return correct channel ID for known types', () => {
            expect(pushService.getChannelId('pokemon_catch')).to.equal('catches');
            expect(pushService.getChannelId('gym_battle')).to.equal('battles');
            expect(pushService.getChannelId('friend_request')).to.equal('social');
            expect(pushService.getChannelId('event_reminder')).to.equal('events');
            expect(pushService.getChannelId('system_announcement')).to.equal('system');
        });

        it('should return general channel for unknown types', () => {
            expect(pushService.getChannelId('unknown')).to.equal('general');
        });
    });

    describe('formatData', () => {
        it('should convert all values to strings', () => {
            const data = {
                userId: 123,
                name: 'test',
                active: true,
                score: 99.5
            };

            const result = pushService.formatData(data);

            expect(result.userId).to.equal('123');
            expect(result.name).to.equal('test');
            expect(result.active).to.equal('true');
            expect(result.score).to.equal('99.5');
        });

        it('should handle empty data', () => {
            const result = pushService.formatData({});
            expect(Object.keys(result)).to.have.lengthOf(0);
        });
    });

    describe('getNextActiveTime', () => {
        it('should calculate next active time correctly', () => {
            const preferences = {
                quiet_hours_end: '08:00',
                timezone: 'UTC'
            };

            const result = pushService.getNextActiveTime(preferences);

            expect(result).to.be.instanceof(Date);
            expect(result.getHours()).to.equal(8);
            expect(result.getMinutes()).to.equal(0);
        });
    });

    describe('registerDeviceToken', () => {
        it('should register new device token', async () => {
            mockClient.query.resolves({
                rows: [{
                    id: 1,
                    user_id: 'user-123',
                    device_id: 'device-456',
                    platform: 'android',
                    token: 'test-token'
                }]
            });

            pushService.initialized = true;
            const result = await pushService.registerDeviceToken({
                userId: 'user-123',
                deviceId: 'device-456',
                platform: 'android',
                token: 'test-token'
            });

            expect(result).to.have.property('id');
            expect(result.user_id).to.equal('user-123');
            expect(result.platform).to.equal('android');
        });

        it('should update existing device token', async () => {
            mockClient.query.resolves({
                rows: [{
                    id: 1,
                    user_id: 'user-123',
                    device_id: 'device-456',
                    platform: 'android',
                    token: 'new-token'
                }]
            });

            pushService.initialized = true;
            const result = await pushService.registerDeviceToken({
                userId: 'user-123',
                deviceId: 'device-456',
                platform: 'android',
                token: 'new-token'
            });

            expect(result.token).to.equal('new-token');
        });
    });

    describe('getUserPreferences', () => {
        it('should return existing preferences', async () => {
            mockClient.query.resolves({
                rows: [{
                    user_id: 'user-123',
                    global_enabled: true,
                    pokemon_catch: true,
                    marketing: false
                }]
            });

            const result = await pushService.getUserPreferences('user-123');

            expect(result.global_enabled).to.be.true;
            expect(result.pokemon_catch).to.be.true;
            expect(result.marketing).to.be.false;
        });

        it('should create default preferences for new user', async () => {
            mockClient.query.onFirstCall().resolves({ rows: [] });
            mockClient.query.onSecondCall().resolves({
                rows: [{
                    user_id: 'user-123',
                    global_enabled: true
                }]
            });

            const result = await pushService.getUserPreferences('user-123');

            expect(result.global_enabled).to.be.true;
        });
    });

    describe('updateUserPreferences', () => {
        it('should update user preferences', async () => {
            mockClient.query.resolves({
                rows: [{
                    user_id: 'user-123',
                    global_enabled: false,
                    marketing: true
                }]
            });

            const result = await pushService.updateUserPreferences('user-123', {
                global_enabled: false,
                marketing: true
            });

            expect(result.global_enabled).to.be.false;
            expect(result.marketing).to.be.true;
        });
    });
});

describe('getPushNotificationService', () => {
    it('should return singleton instance', async () => {
        const instance1 = await getPushNotificationService();
        const instance2 = await getPushNotificationService();

        expect(instance1).to.equal(instance2);
    });
});
