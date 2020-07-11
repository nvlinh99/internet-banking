const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');

const { Customer, Identity, Staff, Role } = require('../models');
const AppError = require('../utils/appError');
const passwordValidator = require('../utils/passwordValidator');
const { STATUS } = require('../utils/statusEnum');

const multerStorage = multer.memoryStorage();

const multerFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image')) {
    cb(null, true);
  } else {
    cb(new AppError('Not an image! Please upload only images.', 400), false);
  }
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
});

exports.uploadIdentityImages = upload.fields([
  {
    name: 'frontImage',
    maxCount: 1,
  },
  {
    name: 'backImage',
    maxCount: 1,
  },
]);

exports.compressIdentityImages = asyncHandler(async (req, res, next) => {
  if (!req.files.frontImage || !req.files.backImage)
    return next(new AppError('Please provide front and back images!', 400));

  // front image
  req.body.frontImage = await sharp(req.files.frontImage[0].buffer)
    .toFormat('jpeg')
    .jpeg({ quality: 80 })
    .toBuffer();

  // back image
  req.body.backImage = await sharp(req.files.backImage[0].buffer)
    .toFormat('jpeg')
    .jpeg({ quality: 80 })
    .toBuffer();

  next();
});

const signToken = (type, id) => {
  return jwt.sign({ type, id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

exports.authorize = asyncHandler(async (req, res, next) => {
  // Get token
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }

  // Verify token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // Check user exists
  let currentUser = null;
  switch (decoded.type) {
    case 'customer':
      currentUser = await Customer.findOne({ where: { id: decoded.id } });
      break;
    case 'staff':
      currentUser = await Staff.findOne({
        include: { model: Role },
        where: { id: decoded.id },
      });
      break;
    default:
  }

  if (!currentUser || (currentUser && currentUser.status === STATUS.deleted)) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exists.',
        401
      )
    );
  }

  // Check status
  switch (currentUser.status) {
    case STATUS.inactive:
      return next(new AppError('Your account is inactive!', 403));
    case STATUS.blocked:
      return next(new AppError('Your account is blocked!', 403));
    default:
  }

  // Should check user have changed password

  // GRANT ACCESS
  req.user = currentUser;
  next();
});

// Only use for admin & staff
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user.Role || !roles.includes(req.user.Role.roleDescription)) {
      return next(
        new AppError('You do not have permission to perform this action.', 403)
      );
    }
    next();
  };
};

exports.customerLogin = asyncHandler(async (req, res, next) => {
  const { username, password } = req.body;

  // Check if email and password exist
  if (!username || !password) {
    return next(
      new AppError('Please provide username/email and password!', 400)
    );
  }

  // Check if customer exists && password is correct
  const customer = await Customer.findOne({
    where: {
      [Op.or]: [{ username }, { email: username }],
      status: { [Op.ne]: STATUS.deleted },
    },
  });

  if (
    !customer ||
    !(await passwordValidator.verifyHashedPassword(password, customer.password))
  ) {
    return next(new AppError('Incorrect username/email or password', 401));
  }

  // Create login token and send to client
  const token = signToken('customer', customer.id);

  return res.status(200).json({
    status: 'success',
    token,
  });
});

exports.customerRegister = asyncHandler(async (req, res, next) => {
  console.log('REQ.BODY', req.body);
  console.log('REQ.BODY.IMAGES', req.body.frontImage, req.body.backImage);

  const {
    email,
    username,
    password,
    name,
    dateOfBirth,
    phoneNumber,
    address,

    identityNumber,
    registrationDate,
    frontImage,
    backImage,
  } = req.body;

  const regexPwd = /^(?=.*[\d])(?=.*[A-Z])(?=.*[a-z])(?=.*[!@#$%^&*])[\w!@#$%^&*]{8,}$/gm;
  const regexDoB = /^\d{4}[/-]\d{2}[/-]\d{2}$/gm;
  const regexIdentNum = /^[0-9]{9}$|^[0-9]{12}$/gm;
  const regexRegDate = /^\d{4}[/-]\d{2}[/-]\d{2}$/gm;
  const matchedPwd = regexPwd.exec(password);
  const matchedDoB = regexDoB.exec(dateOfBirth);
  const matchedIdentNum = regexIdentNum.exec(identityNumber);
  const matchedRegDate = regexRegDate.exec(registrationDate);

  if (!matchedPwd) {
    return next(
      new AppError(
        'Password must be minimum eight characters, at least one uppercase letter, one lowercase letter, one number and one special character.',
        400
      )
    );
  }

  if (!matchedDoB) {
    return next(new AppError('Date of birth is invalid', 400));
  }

  if (!identityNumber || !registrationDate || !frontImage || !backImage) {
    return next(new AppError('Please provide a full identity.', 400));
  }

  if (!matchedIdentNum) {
    return next(
      new AppError('Identity number must be 9 or 12 characters in length.', 400)
    );
  }

  if (!matchedRegDate) {
    return next(new AppError('Date of registration is invalid', 400));
  }

  // Create new customer
  const customer = await Customer.create({
    username: username.trim().toLowerCase(),
    email: email.trim().toLowerCase(),
    password: await passwordValidator.createHashedPassword(password),
    name,
    dateOfBirth,
    phoneNumber,
    address,
    verifyCode: uuidv4(),
  });

  await Identity.create({
    customerId: customer.id,
    identityNumber,
    registrationDate,
    frontImage: req.body.frontImage,
    backImage: req.body.backImage,
  });

  // Create login token and send to client
  const token = signToken('customer', customer.id);

  return res.status(201).json({
    status: 'success',
    token,
  });
});

exports.staffLogin = asyncHandler(async (req, res, next) => {
  const { username, password } = req.body;

  // Check if email and password exist
  if (!username || !password) {
    return next(
      new AppError('Please provide username/email and password!', 400)
    );
  }

  // Check if staff exists && password is correct
  const staff = await Staff.findOne({
    where: {
      username,
      status: { [Op.ne]: STATUS.deleted },
    },
  });

  if (
    !staff ||
    !(await passwordValidator.verifyHashedPassword(password, staff.password))
  ) {
    return next(new AppError('Incorrect username/email or password', 401));
  }

  // Create login token and send to client
  const token = signToken('staff', staff.id);

  return res.status(200).json({
    status: 'success',
    token,
  });
});
