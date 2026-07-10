App({
  onLaunch() {
    // 初始化全局权限状态 userStatus
    let userStatus = wx.getStorageSync('userStatus');
    if (!userStatus) {
      userStatus = {
        isVIP: false,
        dailyTriesLeft: 10,
        lastUpdatedDate: this.getTodayDate()
      };
      wx.setStorageSync('userStatus', userStatus);
    } else {
      // 跨天重置免费次数
      const today = this.getTodayDate();
      if (userStatus.lastUpdatedDate !== today) {
        userStatus.dailyTriesLeft = 10;
        userStatus.lastUpdatedDate = today;
        wx.setStorageSync('userStatus', userStatus);
      }
    }
    this.globalData.userStatus = userStatus;
  },

  getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  },

  updateUserStatus(status) {
    this.globalData.userStatus = { ...this.globalData.userStatus, ...status };
    wx.setStorageSync('userStatus', this.globalData.userStatus);
  },

  globalData: {
    userStatus: null
  }
});
