from django.contrib import admin
from django.utils.html import format_html

from .models import Family, Figure, Genus, Reference, Species, Structure

admin.site.site_header = "蜘蛛文獻圖片資料庫 管理後台"
admin.site.site_title = "蜘蛛文獻圖片資料庫"


@admin.register(Family)
class FamilyAdmin(admin.ModelAdmin):
    list_display = ["name", "author", "common_name"]
    search_fields = ["name", "common_name"]


@admin.register(Genus)
class GenusAdmin(admin.ModelAdmin):
    list_display = ["name", "author", "family", "common_name"]
    list_filter = ["family"]
    search_fields = ["name", "common_name"]
    autocomplete_fields = ["family"]


@admin.register(Species)
class SpeciesAdmin(admin.ModelAdmin):
    list_display = ["__str__", "author", "common_name", "valid_species"]
    list_filter = ["genus__family"]
    search_fields = ["genus__name", "epithet", "common_name"]
    autocomplete_fields = ["genus", "valid_species"]
    list_select_related = ["genus", "valid_species__genus"]


@admin.register(Reference)
class ReferenceAdmin(admin.ModelAdmin):
    list_display = ["authors", "year", "title", "journal"]
    search_fields = ["authors", "title", "year", "doi"]


@admin.register(Structure)
class StructureAdmin(admin.ModelAdmin):
    list_display = ["name", "name_en", "order"]
    list_editable = ["order"]


@admin.register(Figure)
class FigureAdmin(admin.ModelAdmin):
    list_display = ["thumb", "species", "source_label", "structure", "sex", "uploaded_by", "created_at"]
    list_filter = ["structure", "sex", "view"]
    search_fields = ["species__genus__name", "species__epithet", "reference__authors", "figure_number"]
    autocomplete_fields = ["species", "reference"]
    list_select_related = ["species__genus", "reference", "structure", "uploaded_by"]

    @admin.display(description="縮圖")
    def thumb(self, obj):
        if obj.thumbnail:
            return format_html('<img src="{}" style="height:60px">', obj.thumbnail.url)
        return ""

    def save_model(self, request, obj, form, change):
        if not obj.uploaded_by_id:
            obj.uploaded_by = request.user
        super().save_model(request, obj, form, change)
