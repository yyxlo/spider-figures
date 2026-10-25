from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import path

from catalog import views

urlpatterns = [
    path("", views.home, name="home"),
    path("search/", views.search, name="search"),
    path("api/autocomplete/", views.api_autocomplete, name="api_autocomplete"),
    path("api/references/", views.api_references, name="api_references"),
    path("taxa/", views.taxa_index, name="taxa_index"),
    path("family/<int:pk>/", views.family_detail, name="family_detail"),
    path("genus/<int:pk>/", views.genus_detail, name="genus_detail"),
    path("species/new/", views.species_create, name="species_create"),
    path("species/<int:pk>/", views.species_detail, name="species_detail"),
    path("compare/", views.compare, name="compare"),
    path("upload/", views.upload, name="upload"),
    path("figure/batch-edit/", views.figure_batch_edit, name="figure_batch_edit"),
    path("figure/<int:pk>/", views.figure_detail, name="figure_detail"),
    path("figure/<int:pk>/edit/", views.figure_edit, name="figure_edit"),
    path("figure/<int:pk>/delete/", views.figure_delete, name="figure_delete"),
    path("references/", views.reference_list, name="reference_list"),
    path("reference/new/", views.reference_edit, name="reference_create"),
    path("reference/<int:pk>/", views.reference_detail, name="reference_detail"),
    path("reference/<int:pk>/edit/", views.reference_edit, name="reference_edit"),
    path("reference/<int:pk>/bibtex/", views.reference_bibtex, name="reference_bibtex"),
    path("media/<path:path>", views.protected_media, name="media"),
    path("accounts/login/", auth_views.LoginView.as_view(), name="login"),
    path("accounts/logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("accounts/password/", auth_views.PasswordChangeView.as_view(), name="password_change"),
    path("accounts/password/done/", auth_views.PasswordChangeDoneView.as_view(),
         name="password_change_done"),
    path("admin/", admin.site.urls),
]
