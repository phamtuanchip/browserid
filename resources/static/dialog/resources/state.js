/*jshint browser:true, jQuery: true, forin: true, laxbreak:true */
/*global BrowserID: true */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
BrowserID.State = (function() {
  var bid = BrowserID,
      storage = bid.Storage,
      network = bid.Network,
      mediator = bid.Mediator,
      helpers = bid.Helpers,
      user = bid.User,
      moduleManager = bid.module,
      complete = bid.Helpers.complete,
      controller,
      addPrimaryUser = false,
      email,
      requiredEmail,
      primaryVerificationInfo;

  function startStateMachine() {
    var self = this,
        handleState = self.subscribe.bind(self),
        redirectToState = mediator.publish.bind(mediator),
        startAction = function(save, msg, options) {
          if (typeof save !== "boolean") {
            options = msg;
            msg = save;
            save = true;
          }

          var func = controller[msg].bind(controller);
          self.gotoState(save, func, options);
        },
        cancelState = self.popState.bind(self);

    handleState("start", function(msg, info) {
      info = info || {};

      self.hostname = info.hostname;
      self.privacyURL = info.privacyURL;
      self.tosURL = info.tosURL;
      requiredEmail = info.requiredEmail;

      if ((typeof(requiredEmail) !== "undefined") && (!bid.verifyEmail(requiredEmail))) {
        // Invalid format
        startAction("doError", "invalid_required_email", {email: requiredEmail});
      }
      else if (info.email && info.type === "primary") {
        primaryVerificationInfo = info;
        redirectToState("primary_user", info);
      }
      else {
        startAction("doCheckAuth");
      }
    });

    handleState("cancel", function() {
      startAction("doCancel");
    });

    handleState("window_unload", function() {
      if (!self.success) {
        storage.setStagedOnBehalfOf("");
        // do not call doCancel here, let winchan's cancel
        // handling do the work. This gives us consistent semantics
        // across browsers on the RP side of the WinChan.
      }
    });

    handleState("authentication_checked", function(msg, info) {
      var authenticated = info.authenticated;

      if (requiredEmail) {
        self.email = requiredEmail;
        startAction("doAuthenticateWithRequiredEmail", {
          email: requiredEmail,
          privacyURL: self.privacyURL,
          tosURL: self.tosURL
        });
      }
      else if (authenticated) {
        redirectToState("pick_email");
      } else {
        redirectToState("authenticate");
      }
    });

    handleState("authenticate", function(msg, info) {
      info = info || {};
      info.privacyURL = self.privacyURL;
      info.tosURL = self.tosURL;
      startAction("doAuthenticate", info);
    });

    handleState("user_staged", function(msg, info) {
      self.stagedEmail = info.email;
      info.required = !!requiredEmail;
      startAction("doConfirmUser", info);
    });

    handleState("user_confirmed", function() {
      self.email = self.stagedEmail;
      redirectToState("email_chosen", { email: self.stagedEmail} );
    });

    handleState("primary_user", function(msg, info) {
      addPrimaryUser = !!info.add;
      email = info.email;

      var idInfo = storage.getEmail(email);
      if (idInfo && idInfo.cert) {
        redirectToState("primary_user_ready", info);
      }
      else {
        // We don't want to put the provisioning step on the stack, instead when
        // a user cancels this step, they should go back to the step before the
        // provisioning.
        startAction(false, "doProvisionPrimaryUser", info);
      }
    });

    handleState("primary_user_provisioned", function(msg, info) {
      info = info || {};
      info.add = !!addPrimaryUser;
      // The user is is authenticated with their IdP. Two possibilities exist
      // for the email - 1) create a new account or 2) add address to the
      // existing account. If the user is authenticated with BrowserID, #2
      // will happen. If not, #1.
      startAction("doPrimaryUserProvisioned", info);
    });

    handleState("primary_user_unauthenticated", function(msg, info) {
      info = helpers.extend(info || {}, {
        add: !!addPrimaryUser,
        email: email,
        requiredEmail: !!requiredEmail,
        privacyURL: self.privacyURL,
        tosURL: self.tosURL
      });

      if (primaryVerificationInfo) {
        primaryVerificationInfo = null;
        if (requiredEmail) {
          startAction("doCannotVerifyRequiredPrimary", info);
        }
        else if (info.add) {
          // Add the pick_email in case the user cancels the add_email screen.
          // The user needs something to go "back" to.
          redirectToState("pick_email");
          redirectToState("add_email", info);
        }
        else {
          redirectToState("authenticate", info);
        }
      }
      else {
        startAction("doVerifyPrimaryUser", info);
      }
    });

    handleState("primary_user_authenticating", function(msg, info) {
      // Keep the dialog from automatically closing when the user browses to
      // the IdP for verification.
      moduleManager.stopAll();
      self.success = true;
    });

    handleState("primary_user_ready", function(msg, info) {
      redirectToState("email_chosen", info);
    });

    handleState("pick_email", function() {
      startAction("doPickEmail", {
        origin: self.hostname,
        privacyURL: self.privacyURL,
        tosURL: self.tosURL
      });
    });

    handleState("email_chosen", function(msg, info) {
      info = info || {};

      var email = info.email,
          idInfo = storage.getEmail(email);

      self.email = email;

      function oncomplete() {
        complete(info.complete);
      }

      if (idInfo) {
        if (idInfo.type === "primary") {
          if (idInfo.cert) {
            // Email is a primary and the cert is available - the user can log
            // in without authenticated with the primary.
            redirectToState("email_valid_and_ready", info);
          }
          else {
            // If the email is a primary and the cert is not available,
            // throw the user down the primary flow. The primary flow will
            // catch cases where the primary certificate is expired
            // and the user must re-verify with their IdP.
            redirectToState("primary_user", info);
          }
        }
        else {
          user.checkAuthentication(function(authentication) {
            if (authentication === "assertion") {
              // user must authenticate with their password, kick them over to
              // the required email screen to enter the password.
              startAction("doAuthenticateWithRequiredEmail", {
                email: email,
                secondary_auth: true,
                privacyURL: self.privacyURL,
                tosURL: self.tosURL
              });
            }
            else {
              redirectToState("email_valid_and_ready", info);
            }
            oncomplete();
          }, oncomplete);
        }
      }
      else {
        throw "invalid email";
      }
    });

    handleState("email_valid_and_ready", function(msg, info) {
      // At this stage, we know that the email the user is trying to
      // authenticate with is valid, it has been confirmed, and it has a valid
      // key.  Before generating an assertion, check to see if the user has
      // verified whether the ownership status of this computer. If the user
      // needs asked, ask them and generate the assertion once they finish the
      // response.  If they do not need to be asked, generate the assertion
      // now.
      user.shouldAskIfUsersComputer(function(shouldAsk) {
        if (shouldAsk) {
          redirectToState("is_this_your_computer", info);
        }
        else {
          redirectToState("generate_assertion", info);
        }
      });
    });

    handleState("is_this_your_computer", function(msg, info) {
      // We have to confirm the user's computer ownership status.  Save off
      // the selected email info for when the user_computer_status_set is
      // complete so that the user can continue the flow with the correct
      // email address.
      self.chosenEmailInfo = info;
      startAction("doIsThisYourComputer", info);
    });

    handleState("user_computer_status_set", function(msg, info) {
      // User's status has been confirmed, an assertion can safely be
      // generated as there are no more delays introduced by user interaction.
      // Use the email address that was stored in the call to
      // "is_this_your_computer".
      var emailInfo = self.chosenEmailInfo;
      self.chosenEmailInfo = null;
      redirectToState("generate_assertion", emailInfo);
    });

    handleState("generate_assertion", function(msg, info) {
      startAction("doGenerateAssertion", info);
    });

    handleState("assertion_generated", function(msg, info) {
      self.success = true;
      if (info.assertion !== null) {
        // XXX TODO - move the setLoggedIn to the getAssertion perhaps?
        storage.setLoggedIn(user.getOrigin(), self.email);
        startAction("doAssertionGenerated", { assertion: info.assertion, email: self.email });
      }
      else {
        redirectToState("pick_email");
      }
    });

    handleState("notme", function() {
      startAction("doNotMe");
    });

    handleState("logged_out", function() {
      redirectToState("authenticate");
    });

    handleState("authenticated", function(msg, info) {
      redirectToState("email_chosen", info);
    });

    handleState("forgot_password", function(msg, info) {
      // forgot password initiates the forgotten password flow.
      startAction(false, "doForgotPassword", info);
    });

    handleState("reset_password", function(msg, info) {
      // reset password says the password has been reset, now waiting for
      // confirmation.
      startAction(false, "doResetPassword", info);
    });

    handleState("add_email", function(msg, info) {
      info = helpers.extend(info || {}, {
        privacyURL: self.privacyURL,
        tosURL: self.tosURL
      });

      startAction("doAddEmail", info);
    });

    handleState("email_staged", function(msg, info) {
      self.stagedEmail = info.email;
      info.required = !!requiredEmail;
      startAction("doConfirmEmail", info);
    });

    handleState("email_confirmed", function() {
      redirectToState("email_chosen", { email: self.stagedEmail} );
    });

    handleState("cancel_state", function(msg, info) {
      cancelState(info);
    });

  }

  var State = BrowserID.StateMachine.extend({
    start: function(options) {
      options = options || {};

      controller = options.controller;
      if (!controller) {
        throw "start: controller must be specified";
      }

      addPrimaryUser = false;
      email = requiredEmail = null;

      State.sc.start.call(this, options);
      startStateMachine.call(this);
    }
  });

  return State;
}());

