const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');

const ROLE = require('../utils/enums/roleEnum');
const { STATUS } = require('../utils/enums/statusEnum');
const passwordValidator = require('../utils/passwordValidator');
const AppError = require('../utils/appError');
const { Staff, Role } = require('../models');

const LogService = require('../services/logService');

const excludeAdmin = {
  model: Role,
  where: {
    roleDescription: { [Op.ne]: ROLE.admin },
  },
};

const findStaff = asyncHandler(async (id) => {
  const staff = await Staff.findOne({
    include: excludeAdmin,
    attributes: {
      exclude: ['password', 'roleId', 'passwordUpdatedAt'],
    },
    where: {
      [Op.and]: [
        { id },
        {
          status: {
            [Op.ne]: STATUS.deleted,
          },
        },
      ],
    },
  });

  return staff;
});

exports.getAllStaffs = asyncHandler(async (req, res, next) => {
  const attributes = ['username', 'name'];
  const sortTypes = ['asc', 'desc'];
  let { sortBy, sortType, page, limit } = req.query;

  if (!page || page <= 0) page = 1;
  if (!limit || limit <= 0) limit = 10;

  if (!sortType || (sortType && !sortTypes.includes(sortType)))
    sortType = 'asc';
  if (!sortBy || (sortBy && !attributes.includes(sortBy))) sortBy = 'updatedAt';

  const filterArr = [];
  attributes.forEach((attr) => {
    if (req.query[attr]) {
      const obj = {};
      obj[attr] = { [Op.like]: `%${req.query[attr]}%` };
      filterArr.push(obj);
    }
  });

  const staffs = await Staff.findAndCountAll({
    include: excludeAdmin,
    attributes: {
      exclude: ['password', 'roleId', 'passwordUpdatedAt'],
    },
    where: {
      [Op.and]: [
        {
          status: {
            [Op.ne]: STATUS.deleted,
          },
        },
        ...filterArr,
      ],
    },
    order: [[sortBy, sortType]],
    offset: (page - 1) * limit,
    limit,
  });

  return res.status(200).json({
    status: 'success',
    totalItems: staffs.count,
    items: staffs.rows,
  });
});

exports.createStaff = asyncHandler(async (req, res, next) => {
  const staffRole = await Role.findOne({
    where: { roleDescription: { [Op.eq]: ROLE.staff } },
  });

  if (!staffRole) {
    return next(new AppError("Can't find staff role!", 500));
  }

  const staff = await Staff.create({
    username: req.body.username,
    password: await passwordValidator.createHashedPassword(req.body.password),
    name: req.body.name,
    roleId: staffRole.id,
  });

  const newStaff = { ...staff.dataValues };
  delete newStaff.roleId;
  delete newStaff.password;
  delete newStaff.passwordUpdatedAt;

  return res.status(201).json({
    status: 'success',
    data: newStaff,
  });
});

exports.getStaff = asyncHandler(async (req, res, next) => {
  const staff = await findStaff(req.params.id);

  if (!staff) {
    return next(new AppError("Can't find that staff!", 404));
  }

  return res.status(200).json({
    status: 'success',
    data: staff,
  });
});

exports.updateStaffStatus = asyncHandler(async (req, res, next) => {
  const { idStaff, status } = req.body;

  const newStatus = STATUS[status];
  if (!newStatus) {
    return next(new AppError('Status is not valid!', 400));
  }

  const staff = await Staff.findOne({
    include: excludeAdmin,
    attributes: {
      exclude: ['password', 'roleId', 'passwordUpdatedAt'],
    },
    where: { id: idStaff },
  });
  if (!staff) {
    return next(new AppError("Can't find that staff!", 404));
  }

  staff.status = newStatus;
  await staff.save();

  return res.status(200).json({
    status: 'success',
    data: staff,
  });
});

exports.getLogs = asyncHandler(async (req, res, next) => {
  let { page, limit } = req.query;
  const { staffId } = req.query;

  if (!page || page <= 0) page = 1;
  if (!limit || limit <= 0) limit = 50;

  let filterStaff = null;
  if (staffId) filterStaff = { staffId };

  const logs = await LogService.getLogs({
    where: filterStaff,
    order: [['updatedAt', 'DESC']],
    offset: (page - 1) * limit,
    limit,
  });
  return res.status(200).json({
    status: 'success',
    totalItems: logs.count,
    items: logs.rows,
  });
});
