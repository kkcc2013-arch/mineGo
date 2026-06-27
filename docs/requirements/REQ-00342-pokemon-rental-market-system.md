# REQ-00342: 精灵租赁市场与短期使用系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00342 |
| 标题 | 精灵租赁市场与短期使用系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、social-service、user-service、payment-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-26 11:00 UTC |

## 需求描述

构建一个完整的精灵租赁市场系统，允许玩家将闲置精灵出租给其他玩家使用，租借方可支付游戏币短期获得精灵的使用权。该系统将：

1. **创建租赁经济生态**：为拥有稀有或强力精灵的玩家提供收益渠道
2. **降低新手门槛**：新手玩家可租用高等级精灵体验高级内容
3. **增加社交互动**：促进玩家间的信任与合作
4. **资源优化利用**：提高精灵资源的整体利用率

### 核心功能

- 精灵上架与租赁定价
- 租赁期限管理（1小时/6小时/24小时/7天）
- 押金与保险机制
- 租赁期间精灵使用权限控制
- 租赁历史与评价系统
- 逾期处理与自动归还

## 技术方案

### 1. 数据库设计

```sql
-- 租赁市场表
CREATE TABLE pokemon_rental_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    
    -- 租赁定价
    price_per_hour INTEGER NOT NULL,           -- 每小时租金
    price_per_day INTEGER,                     -- 每天租金（折扣价）
    deposit_amount INTEGER NOT NULL,           -- 押金金额
    
    -- 租赁期限设置
    min_rental_hours INTEGER DEFAULT 1,        -- 最短租期
    max_rental_hours INTEGER DEFAULT 168,      -- 最长租期（7天）
    
    -- 状态
    status VARCHAR(20) DEFAULT 'available',    -- available/rented/offline
    current_rental_id UUID,                    -- 当前租赁ID
    
    -- 统计
    total_rentals INTEGER DEFAULT 0,
    total_earnings INTEGER DEFAULT 0,
    average_rating DECIMAL(3,2) DEFAULT 0,
    
    -- 时间戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_price CHECK (price_per_hour > 0),
    CONSTRAINT chk_deposit CHECK (deposit_amount >= 0)
);

-- 租赁订单表
CREATE TABLE pokemon_rental_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES pokemon_rental_listings(id),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    renter_user_id UUID NOT NULL REFERENCES users(id),
    
    -- 租赁信息
    rental_hours INTEGER NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    
    -- 费用明细
    rental_fee INTEGER NOT NULL,               -- 租金
    deposit_paid INTEGER NOT NULL,             -- 已付押金
    insurance_fee INTEGER DEFAULT 0,           -- 保险费
    total_amount INTEGER NOT NULL,             -- 总金额
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active',       -- active/completed/cancelled/overdue/disputed
    
    -- 评价
    owner_rating INTEGER,                      -- 租客给出租者的评分(1-5)
    renter_rating INTEGER,                     -- 出租者给租客的评分(1-5)
    owner_review TEXT,
    renter_review TEXT,
    
    -- 逾期处理
    overdue_fee INTEGER DEFAULT 0,
    actual_return_time TIMESTAMP,
    
    -- 争议处理
    dispute_reason TEXT,
    dispute_resolved_at TIMESTAMP,
    dispute_resolution TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 租赁保险表
CREATE TABLE rental_insurance_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES pokemon_rental_orders(id),
    
    insurance_type VARCHAR(20) NOT NULL,       -- basic/standard/premium
    coverage_percentage INTEGER NOT NULL,      -- 覆盖百分比
    premium_amount INTEGER NOT NULL,           -- 保费
    
    -- 理赔
    claim_status VARCHAR(20),                  -- pending/approved/rejected
    claim_amount INTEGER,
    claim_reason TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化
CREATE INDEX idx_rental_listings_pokemon ON pokemon_rental_listings(pokemon_id);
CREATE INDEX idx_rental_listings_owner ON pokemon_rental_listings(owner_user_id);
CREATE INDEX idx_rental_listings_status ON pokemon_rental_listings(status);
CREATE INDEX idx_rental_orders_renter ON pokemon_rental_orders(renter_user_id);
CREATE INDEX idx_rental_orders_status ON pokemon_rental_orders(status);
CREATE INDEX idx_rental_orders_time ON pokemon_rental_orders(start_time, end_time);
```

### 2. 租赁服务核心模块

```javascript
// backend/services/pokemon-service/src/rental/RentalService.js

const { Op } = require('sequelize');
const EventEmitter = require('events');

class RentalService extends EventEmitter {
  constructor(deps) {
    super();
    this.pokemonRepository = deps.pokemonRepository;
    this.rentalRepository = deps.rentalRepository;
    this.userRepository = deps.userRepository;
    this.paymentService = deps.paymentService;
    this.notificationService = deps.notificationService;
    this.cacheService = deps.cacheService;
    this.config = deps.config;
  }

  /**
   * 上架精灵到租赁市场
   */
  async createListing(userId, pokemonId, listingData) {
    // 1. 验证精灵所有权
    const pokemon = await this.pokemonRepository.findById(pokemonId);
    if (!pokemon || pokemon.userId !== userId) {
      throw new Error('POKEMON_NOT_OWNED');
    }

    // 2. 检查精灵状态
    if (pokemon.status === 'rented') {
      throw new Error('POKEMON_ALREADY_RENTED');
    }

    // 3. 检查精灵是否满足上架条件
    if (!this.canBeListed(pokemon)) {
      throw new Error('POKEMON_CANNOT_BE_LISTED');
    }

    // 4. 计算推荐价格
    const recommendedPrice = this.calculateRecommendedPrice(pokemon);

    // 5. 创建租赁上架记录
    const listing = await this.rentalRepository.createListing({
      pokemonId,
      ownerUserId: userId,
      pricePerHour: listingData.pricePerHour || recommendedPrice.hourly,
      pricePerDay: listingData.pricePerDay || recommendedPrice.daily,
      depositAmount: listingData.depositAmount || this.calculateDeposit(pokemon),
      minRentalHours: listingData.minRentalHours || 1,
      maxRentalHours: listingData.maxRentalHours || 168,
      status: 'available'
    });

    // 6. 更新精灵状态
    await this.pokemonRepository.update(pokemonId, {
      listingStatus: 'listed',
      listingId: listing.id
    });

    // 7. 缓存上架信息
    await this.cacheListing(listing);

    // 8. 发送通知
    this.emit('listing:created', { listing, pokemon, userId });

    return listing;
  }

  /**
   * 租用精灵
   */
  async rentPokemon(renterId, listingId, rentalOptions) {
    const listing = await this.rentalRepository.findListingById(listingId);
    
    if (!listing || listing.status !== 'available') {
      throw new Error('LISTING_NOT_AVAILABLE');
    }

    // 1. 验证租期
    const rentalHours = rentalOptions.hours;
    if (rentalHours < listing.minRentalHours || rentalHours > listing.maxRentalHours) {
      throw new Error('INVALID_RENTAL_DURATION');
    }

    // 2. 检查租客是否符合条件
    await this.validateRenter(renterId, listing);

    // 3. 计算费用
    const feeCalculation = this.calculateRentalFee(listing, rentalHours, rentalOptions.insuranceType);

    // 4. 扣款
    await this.paymentService.processRentalPayment({
      renterId,
      ownerId: listing.ownerUserId,
      amount: feeCalculation.totalAmount,
      deposit: feeCalculation.deposit,
      insuranceFee: feeCalculation.insuranceFee,
      reference: `rental-${listingId}`
    });

    // 5. 创建租赁订单
    const order = await this.rentalRepository.createOrder({
      listingId,
      pokemonId: listing.pokemonId,
      ownerUserId: listing.ownerUserId,
      renterUserId: renterId,
      rentalHours,
      startTime: new Date(),
      endTime: new Date(Date.now() + rentalHours * 60 * 60 * 1000),
      rentalFee: feeCalculation.rentalFee,
      depositPaid: feeCalculation.deposit,
      insuranceFee: feeCalculation.insuranceFee,
      totalAmount: feeCalculation.totalAmount,
      status: 'active'
    });

    // 6. 更新上架状态
    await this.rentalRepository.updateListing(listingId, {
      status: 'rented',
      currentRentalId: order.id
    });

    // 7. 授予精灵使用权
    await this.grantPokemonAccess(order);

    // 8. 设置定时任务（到期提醒、自动归还）
    await this.scheduleRentalTasks(order);

    // 9. 发送通知
    this.emit('rental:started', { order, listing, renterId });

    return order;
  }

  /**
   * 归还精灵
   */
  async returnPokemon(renterId, orderId, returnData) {
    const order = await this.rentalRepository.findOrderById(orderId);
    
    if (!order || order.renterUserId !== renterId) {
      throw new Error('ORDER_NOT_FOUND');
    }

    if (order.status !== 'active') {
      throw new Error('ORDER_NOT_ACTIVE');
    }

    // 1. 检查是否逾期
    const isOverdue = new Date() > order.endTime;
    let overdueFee = 0;

    if (isOverdue) {
      overdueFee = this.calculateOverdueFee(order);
    }

    // 2. 处理押金退还
    const depositRefund = order.depositPaid - overdueFee - (returnData.damageFee || 0);
    
    if (depositRefund > 0) {
      await this.paymentService.refundDeposit(renterId, depositRefund, {
        orderId,
        reason: 'rental_returned'
      });
    }

    // 3. 更新订单状态
    await this.rentalRepository.updateOrder(orderId, {
      status: isOverdue ? 'overdue_completed' : 'completed',
      actualReturnTime: new Date(),
      overdueFee,
      renterRating: returnData.rating,
      renterReview: returnData.review
    });

    // 4. 恢复上架状态
    await this.rentalRepository.updateListing(order.listingId, {
      status: 'available',
      currentRentalId: null,
      totalRentals: listing.totalRentals + 1,
      totalEarnings: listing.totalEarnings + order.rentalFee
    });

    // 5. 撤销精灵使用权
    await this.revokePokemonAccess(order);

    // 6. 清理定时任务
    await this.cancelRentalTasks(orderId);

    // 7. 更新评价统计
    if (returnData.rating) {
      await this.updateRatingStatistics(order.listingId, returnData.rating);
    }

    // 8. 发送通知
    this.emit('rental:returned', { order, isOverdue, overdueFee });

    return {
      orderId,
      status: 'completed',
      depositRefund,
      overdueFee
    };
  }

  /**
   * 搜索可租赁精灵
   */
  async searchListings(searchParams) {
    const {
      pokemonType,
      minLevel,
      maxLevel,
      minPrice,
      maxPrice,
      sortBy = 'rating',  // rating/price/popularity
      page = 1,
      limit = 20
    } = searchParams;

    const query = {
      where: { status: 'available' },
      include: [
        {
          model: 'Pokemon',
          where: {}
        },
        {
          model: 'User',
          attributes: ['id', 'username', 'avatar']
        }
      ]
    };

    // 构建过滤条件
    if (pokemonType) {
      query.include[0].where.type = pokemonType;
    }
    if (minLevel || maxLevel) {
      query.include[0].where.level = {
        [Op.between]: [minLevel || 1, maxLevel || 100]
      };
    }
    if (minPrice || maxPrice) {
      query.where.pricePerHour = {
        [Op.between]: [minPrice || 0, maxPrice || Infinity]
      };
    }

    // 排序
    const orderMap = {
      rating: [['averageRating', 'DESC']],
      price: [['pricePerHour', 'ASC']],
      popularity: [['totalRentals', 'DESC']]
    };
    query.order = orderMap[sortBy] || orderMap.rating;

    // 分页
    query.offset = (page - 1) * limit;
    query.limit = limit;

    const result = await this.rentalRepository.findListings(query);

    return {
      listings: result.rows,
      total: result.count,
      page,
      totalPages: Math.ceil(result.count / limit)
    };
  }

  /**
   * 计算推荐价格
   */
  calculateRecommendedPrice(pokemon) {
    // 基于精灵稀有度、等级、IVs、技能等计算推荐价格
    const basePrice = this.config.rental.basePrices[pokemon.rarity] || 100;
    const levelMultiplier = 1 + (pokemon.level / 100);
    const ivMultiplier = 1 + (pokemon.ivTotal / 600);
    const skillMultiplier = pokemon.hasRareSkills ? 1.5 : 1;

    const hourly = Math.round(basePrice * levelMultiplier * ivMultiplier * skillMultiplier);
    const daily = Math.round(hourly * 20);  // 日租约等于20小时

    return { hourly, daily };
  }

  /**
   * 计算押金
   */
  calculateDeposit(pokemon) {
    const pokemonValue = this.estimatePokemonValue(pokemon);
    return Math.round(pokemonValue * 0.3);  // 押金为精灵价值的30%
  }

  /**
   * 授予精灵临时使用权
   */
  async grantPokemonAccess(order) {
    // 在 Redis 中记录临时使用权
    const accessKey = `pokemon:access:${order.pokemonId}`;
    
    await this.cacheService.set(accessKey, {
      originalOwnerId: order.ownerUserId,
      currentUserId: order.renterUserId,
      orderId: order.id,
      expiresAt: order.endTime
    }, 'EX', order.rentalHours * 3600);

    // 更新精灵的临时拥有者
    await this.pokemonRepository.update(order.pokemonId, {
      tempOwnerId: order.renterUserId,
      rentalOrderId: order.id
    });
  }

  /**
   * 撤销精灵临时使用权
   */
  async revokePokemonAccess(order) {
    const accessKey = `pokemon:access:${order.pokemonId}`;
    await this.cacheService.delete(accessKey);

    await this.pokemonRepository.update(order.pokemonId, {
      tempOwnerId: null,
      rentalOrderId: null
    });
  }

  /**
   * 定时任务调度
   */
  async scheduleRentalTasks(order) {
    // 提前30分钟提醒
    const reminderTime = new Date(order.endTime.getTime() - 30 * 60 * 1000);
    await this.taskScheduler.schedule({
      id: `rental-reminder-${order.id}`,
      executeAt: reminderTime,
      task: 'sendRentalReminder',
      data: { orderId: order.id }
    });

    // 到期自动处理
    await this.taskScheduler.schedule({
      id: `rental-expire-${order.id}`,
      executeAt: order.endTime,
      task: 'handleRentalExpiration',
      data: { orderId: order.id }
    });
  }
}

module.exports = RentalService;
```

### 3. 租赁权限控制中间件

```javascript
// backend/shared/middleware/RentalAccessMiddleware.js

class RentalAccessMiddleware {
  constructor(rentalService, cacheService) {
    this.rentalService = rentalService;
    this.cacheService = cacheService;
  }

  /**
   * 检查精灵使用权
   */
  async checkPokemonAccess(req, res, next) {
    const userId = req.user.id;
    const pokemonId = req.params.pokemonId || req.body.pokemonId;

    try {
      // 1. 检查是否是原拥有者
      const pokemon = await this.rentalService.pokemonRepository.findById(pokemonId);
      
      if (pokemon.userId === userId) {
        req.pokemonAccess = { type: 'owner', pokemon };
        return next();
      }

      // 2. 检查是否是租用者
      const accessKey = `pokemon:access:${pokemonId}`;
      const accessInfo = await this.cacheService.get(accessKey);

      if (accessInfo && accessInfo.currentUserId === userId) {
        // 验证租赁是否有效
        if (new Date(accessInfo.expiresAt) > new Date()) {
          req.pokemonAccess = { 
            type: 'renter', 
            pokemon, 
            orderId: accessInfo.orderId,
            permissions: this.getRenterPermissions(pokemon)
          };
          return next();
        }
      }

      return res.status(403).json({
        error: 'ACCESS_DENIED',
        message: 'You do not have access to this Pokémon'
      });
    } catch (error) {
      return res.status(500).json({
        error: 'ACCESS_CHECK_FAILED',
        message: error.message
      });
    }
  }

  /**
   * 获取租用者权限（限制某些操作）
   */
  getRenterPermissions(pokemon) {
    return {
      canBattle: true,
      canTrain: true,
      canUseItems: true,
      canRelease: false,          // 不能放生
      canTrade: false,            // 不能交易
      canEvolve: true,            // 可以进化
      canTeachSkills: true,       // 可以学习技能
      canChangeName: false,       // 不能改名
      canListForRental: false     // 不能再出租
    };
  }

  /**
   * 限制租赁期间的敏感操作
   */
  restrictRentalOperations(operationType) {
    return (req, res, next) => {
      const { pokemonAccess } = req;

      if (pokemonAccess.type === 'renter') {
        const permissions = pokemonAccess.permissions;
        
        if (!permissions[operationType]) {
          return res.status(403).json({
            error: 'OPERATION_NOT_ALLOWED',
            message: `You cannot ${operationType} a rented Pokémon`
          });
        }
      }

      next();
    };
  }
}

module.exports = RentalAccessMiddleware;
```

### 4. 保险与争议处理系统

```javascript
// backend/services/pokemon-service/src/rental/RentalInsuranceService.js

class RentalInsuranceService {
  constructor(deps) {
    this.config = deps.config;
    this.paymentService = deps.paymentService;
    this.rentalRepository = deps.rentalRepository;
  }

  /**
   * 计算保险费用
   */
  calculateInsurancePremium(order, insuranceType) {
    const basePremium = order.depositPaid;
    
    const tiers = {
      basic: {
        coverage: 0.5,      // 覆盖50%损失
        premiumRate: 0.05   // 保费为押金的5%
      },
      standard: {
        coverage: 0.75,     // 覆盖75%损失
        premiumRate: 0.1    // 保费为押金的10%
      },
      premium: {
        coverage: 0.95,     // 覆盖95%损失
        premiumRate: 0.15   // 保费为押金的15%
      }
    };

    const tier = tiers[insuranceType];
    return {
      premium: Math.round(basePremium * tier.premiumRate),
      coverage: tier.coverage,
      maxClaim: Math.round(basePremium * tier.coverage)
    };
  }

  /**
   * 提交保险理赔
   */
  async submitInsuranceClaim(orderId, claimData) {
    const order = await this.rentalRepository.findOrderById(orderId);
    const policy = await this.rentalRepository.findInsurancePolicy(orderId);

    if (!policy || policy.claimStatus) {
      throw new Error('CLAIM_NOT_ELIGIBLE');
    }

    // 验证损失
    const validatedLoss = await this.validateLoss(claimData, order);

    const claim = await this.rentalRepository.createClaim({
      orderId,
      policyId: policy.id,
      claimAmount: Math.min(validatedLoss.amount, policy.maxClaim),
      claimReason: claimData.reason,
      evidence: claimData.evidence,
      status: 'pending'
    });

    return claim;
  }

  /**
   * 处理争议
   */
  async handleDispute(orderId, disputeData) {
    const order = await this.rentalRepository.findOrderById(orderId);

    if (order.status !== 'active') {
      throw new Error('ORDER_NOT_ACTIVE');
    }

    // 创建争议记录
    const dispute = await this.rentalRepository.createDispute({
      orderId,
      initiatorId: disputeData.initiatorId,
      reason: disputeData.reason,
      evidence: disputeData.evidence,
      status: 'open'
    });

    // 锁定精灵，禁止任何操作
    await this.rentalRepository.updateOrder(orderId, {
      status: 'disputed'
    });

    // 通知双方
    this.emit('dispute:created', { order, dispute });

    return dispute;
  }

  /**
   * 解决争议
   */
  async resolveDispute(disputeId, resolution) {
    const dispute = await this.rentalRepository.findDisputeById(disputeId);
    const order = await this.rentalRepository.findOrderById(dispute.orderId);

    // 根据仲裁结果分配押金
    const depositDistribution = this.calculateDepositDistribution(
      order.depositPaid,
      resolution.responsibleParty,
      resolution.penaltyPercentage
    );

    // 执行赔付
    await this.executeDisputeResolution(order, depositDistribution);

    // 更新状态
    await this.rentalRepository.updateDispute(disputeId, {
      status: 'resolved',
      resolution: resolution.decision,
      resolvedAt: new Date()
    });

    await this.rentalRepository.updateOrder(order.id, {
      status: 'dispute_resolved',
      actualReturnTime: new Date()
    });

    this.emit('dispute:resolved', { order, dispute, resolution });

    return depositDistribution;
  }
}

module.exports = RentalInsuranceService;
```

### 5. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/rental.js

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../shared/middleware/auth');
const RentalAccessMiddleware = require('../../../shared/middleware/RentalAccessMiddleware');
const validate = require('../../../shared/middleware/validate');
const rentalSchemas = require('../validators/rental');

module.exports = (rentalController) => {
  // 上架精灵
  router.post('/listings',
    authenticate,
    validate(rentalSchemas.createListing),
    rentalController.createListing
  );

  // 更新上架信息
  router.put('/listings/:listingId',
    authenticate,
    validate(rentalSchemas.updateListing),
    rentalController.updateListing
  );

  // 下架精灵
  router.delete('/listings/:listingId',
    authenticate,
    rentalController.removeListing
  );

  // 搜索租赁市场
  router.get('/listings',
    validate(rentalSchemas.searchListings),
    rentalController.searchListings
  );

  // 获取上架详情
  router.get('/listings/:listingId',
    rentalController.getListingDetails
  );

  // 租用精灵
  router.post('/listings/:listingId/rent',
    authenticate,
    validate(rentalSchemas.rentPokemon),
    rentalController.rentPokemon
  );

  // 我的租赁（作为租客）
  router.get('/my-rentals',
    authenticate,
    rentalController.getMyRentals
  );

  // 我的出租（作为出租者）
  router.get('/my-listings',
    authenticate,
    rentalController.getMyListings
  );

  // 归还精灵
  router.post('/orders/:orderId/return',
    authenticate,
    validate(rentalSchemas.returnPokemon),
    rentalController.returnPokemon
  );

  // 续租
  router.post('/orders/:orderId/extend',
    authenticate,
    validate(rentalSchemas.extendRental),
    rentalController.extendRental
  );

  // 提交评价
  router.post('/orders/:orderId/review',
    authenticate,
    validate(rentalSchemas.submitReview),
    rentalController.submitReview
  );

  // 提交争议
  router.post('/orders/:orderId/dispute',
    authenticate,
    validate(rentalSchemas.submitDispute),
    rentalController.submitDispute
  );

  // 获取推荐
  router.get('/recommendations',
    authenticate,
    rentalController.getRecommendations
  );

  // 租赁价格估算
  router.post('/estimate-price',
    authenticate,
    validate(rentalSchemas.estimatePrice),
    rentalController.estimatePrice
  );

  return router;
};
```

### 6. 前端组件

```javascript
// frontend/game-client/src/components/RentalMarket/RentalMarket.js

import React, { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { RentalService } from '../../services/RentalService';
import { PokemonCard } from '../Pokemon/PokemonCard';
import { FilterBar } from './FilterBar';
import { RentalDetailsModal } from './RentalDetailsModal';
import { useToast } from '../../hooks/useToast';

export function RentalMarket() {
  const [filters, setFilters] = useState({
    type: null,
    minLevel: 1,
    maxLevel: 100,
    maxPrice: null,
    sortBy: 'rating'
  });
  const [selectedListing, setSelectedListing] = useState(null);
  const toast = useToast();

  const { data: listings, isLoading, refetch } = useQuery({
    queryKey: ['rental-listings', filters],
    queryFn: () => RentalService.searchListings(filters)
  });

  const rentMutation = useMutation({
    mutationFn: RentalService.rentPokemon,
    onSuccess: (data) => {
      toast.success(`Successfully rented ${data.pokemon.name}!`);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  const handleRent = async (listingId, rentalOptions) => {
    await rentMutation.mutateAsync({ listingId, ...rentalOptions });
    setSelectedListing(null);
  };

  return (
    <div className="rental-market">
      <header className="rental-market__header">
        <h2>Pokémon Rental Market</h2>
        <p>Find powerful Pokémon to rent for your adventures!</p>
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
      />

      <div className="rental-market__grid">
        {isLoading ? (
          <div className="loading-spinner" />
        ) : (
          listings?.data.map(listing => (
            <RentalCard
              key={listing.id}
              listing={listing}
              onSelect={() => setSelectedListing(listing)}
              onRent={() => handleRent(listing.id, { hours: 24 })}
            />
          ))
        )}
      </div>

      {selectedListing && (
        <RentalDetailsModal
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
          onRent={handleRent}
          isRenting={rentMutation.isPending}
        />
      )}
    </div>
  );
}

// 租赁卡片组件
function RentalCard({ listing, onSelect, onRent }) {
  const { pokemon, owner, pricePerHour, averageRating } = listing;

  return (
    <div className="rental-card" onClick={onSelect}>
      <div className="rental-card__pokemon">
        <PokemonCard pokemon={pokemon} compact />
      </div>

      <div className="rental-card__info">
        <div className="rental-card__owner">
          <img src={owner.avatar} alt={owner.username} />
          <span>{owner.username}</span>
        </div>

        <div className="rental-card__rating">
          ⭐ {averageRating.toFixed(1)}
          <span className="reviews">({listing.totalRentals} rentals)</span>
        </div>

        <div className="rental-card__price">
          <span className="hourly">{pricePerHour} coins/hour</span>
          {listing.pricePerDay && (
            <span className="daily">Daily: {listing.pricePerDay} coins</span>
          )}
        </div>
      </div>

      <button 
        className="rental-card__rent-btn"
        onClick={(e) => {
          e.stopPropagation();
          onRent();
        }}
      >
        Quick Rent
      </button>
    </div>
  );
}
```

## 验收标准

- [ ] 玩家可以上架精灵到租赁市场，设置租金和押金
- [ ] 玩家可以搜索和筛选可租赁精灵（类型、等级、价格）
- [ ] 租赁流程完整：下单、支付、获得使用权、归还、评价
- [ ] 租赁期间精灵权限控制正确（禁止放生、交易等敏感操作）
- [ ] 押金机制正常：正常归还退还押金，逾期扣除逾期费
- [ ] 租赁保险系统正常工作
- [ ] 争议处理系统可用
- [ ] 租赁到期自动提醒（提前30分钟）
- [ ] 租赁历史和评价系统完整
- [ ] 性能：搜索响应时间 < 500ms，支持分页
- [ ] 安全：所有权验证、权限检查、防刷机制

## 影响范围

### 新增文件
- `backend/services/pokemon-service/src/rental/RentalService.js`
- `backend/services/pokemon-service/src/rental/RentalInsuranceService.js`
- `backend/services/pokemon-service/src/controllers/RentalController.js`
- `backend/services/pokemon-service/src/routes/rental.js`
- `backend/services/pokemon-service/src/validators/rental.js`
- `backend/shared/middleware/RentalAccessMiddleware.js`
- `frontend/game-client/src/components/RentalMarket/`
- `frontend/game-client/src/services/RentalService.js`

### 修改文件
- `database/migrations/` - 新增租赁相关表
- `backend/services/pokemon-service/src/index.js` - 注册路由
- `backend/services/social-service/src/index.js` - 集成社交功能
- `backend/services/payment-service/src/PaymentService.js` - 支持租赁支付
- `backend/shared/middleware/auth.js` - 权限检查增强
- `frontend/game-client/src/router.js` - 添加租赁市场路由

### 数据库变更
- 新增 `pokemon_rental_listings` 表
- 新增 `pokemon_rental_orders` 表
- 新增 `rental_insurance_policies` 表
- 修改 `pokemons` 表添加租赁相关字段

## 参考

- [Pokémon GO Buddy System](https://pokemongolive.com/post/buddy-adventure/)
- [MMORPG Rental Systems Design Patterns](https://gameprogrammingpatterns.com/)
- [Two-Factor Market Design](https://www.nobelprize.org/prizes/economic-sciences/2012/press-release/)
- [Insurance Smart Contracts](https://docs.openzeppelin.com/)
