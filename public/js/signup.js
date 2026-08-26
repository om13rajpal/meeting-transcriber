(function () {
  const form = document.getElementById('signupForm');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const errorBox = document.getElementById('errorBox');
  const submitBtn = document.getElementById('submitBtn');
  const submitSpinner = document.getElementById('submitSpinner');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function hideError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitSpinner.classList.toggle('hidden', !isLoading);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    if (passwordInput.value !== confirmPasswordInput.value) {
      showError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      const resp = await fetch('/api/auth/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.value,
          password: passwordInput.value
        })
      });

      let data = {};
      try {
        data = await resp.json();
      } catch (parseErr) {
        // Non-JSON response body; fall through to generic error below.
      }

      if (!resp.ok) {
        showError(data.error || 'Could not create your account. Please try again.');
        setLoading(false);
        return;
      }

      window.location.href = '/';
    } catch (err) {
      showError('Network error. Please check your connection and try again.');
      setLoading(false);
    }
  });
})();
